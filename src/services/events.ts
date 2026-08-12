import type { Db } from "../db/types";
import { and, eq } from "drizzle-orm";
import { events, webhooks, webhookDeliveries } from "../db/schema";

export type EventType =
  | "email.queued"
  | "email.sent"
  | "email.delivery_failed"
  | "email.received"
  | "email.bounced"
  | "email.rejected";

/**
 * Structural stand-in for ExecutionContext. Hono's `c.executionCtx` and the
 * email handler's `ctx` are nominally different types across workers-types
 * versions; all we need from either is waitUntil.
 */
export interface WaitUntilCtx {
  waitUntil(promise: Promise<unknown>): void;
}

/** Hex HMAC-SHA256, the conventional shape for webhook signatures. */
async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Append a lifecycle event and fan it out to subscribed webhooks.
 *
 * Webhook dispatch is deliberately best-effort: a broken endpoint must never
 * fail an email send or an inbound ingest. Pass ctx to run delivery after the
 * response, so callers don't wait on someone else's slow server.
 */
export async function recordEvent(
  db: Db,
  env: Env,
  opts: {
    messageId: string;
    /** Tenant the message belongs to; only its endpoints are told about it. */
    orgId: string;
    type: EventType;
    detail?: string;
    payload: Record<string, unknown>;
    ctx?: WaitUntilCtx;
  },
): Promise<void> {
  const now = Date.now();
  await db.insert(events).values({
    id: crypto.randomUUID(),
    messageId: opts.messageId,
    type: opts.type,
    detail: opts.detail ?? null,
    createdAt: now,
  });

  const dispatch = deliverToWebhooks(db, opts.orgId, opts.type, {
    type: opts.type,
    createdAt: new Date(now).toISOString(),
    data: opts.payload,
  });

  if (opts.ctx) opts.ctx.waitUntil(dispatch);
  else await dispatch.catch(() => {});
}

/** Attempt, then two retries. Beyond that an endpoint is down, not flapping. */
const ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 5_000];

/** A refusal is final; a timeout, a 5xx or a 429 is worth trying again. */
function worthRetrying(statusCode: number | null): boolean {
  if (statusCode === null) return true; // network error or timeout
  return statusCode === 429 || statusCode >= 500;
}

async function deliverToWebhooks(
  db: Db,
  orgId: string,
  type: EventType,
  body: Record<string, unknown>,
): Promise<void> {
  // Scoped to the tenant the message belongs to. Without this every endpoint on
  // the deployment received every tenant's mail events, addresses and subjects
  // included.
  const hooks = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.enabled, 1), eq(webhooks.orgId, orgId)))
    .all();
  if (hooks.length === 0) return;

  const payload = JSON.stringify(body);

  await Promise.all(
    hooks.map(async (hook) => {
      let subscribed: string[];
      try {
        subscribed = JSON.parse(hook.eventTypes);
      } catch {
        subscribed = ["*"];
      }
      if (!subscribed.includes("*") && !subscribed.includes(type)) return;

      const signature = await sign(hook.secret, payload);
      const started = Date.now();
      let statusCode: number | null = null;
      let error: string | null = null;

      // Every attempt is recorded, not just the last: "delivered on the third
      // try" and "delivered first time" are different facts about an endpoint,
      // and the log is what someone reads when a customer says they missed one.
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        const at = Date.now();
        statusCode = null;
        error = null;
        try {
          const res = await fetch(hook.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "user-agent": "Mittova-Webhook/1.0",
              "x-mittova-event": type,
              "x-mittova-signature": `sha256=${signature}`,
              "x-mittova-attempt": String(attempt),
            },
            body: payload,
            signal: AbortSignal.timeout(10_000),
          });
          statusCode = res.status;
        } catch (err) {
          error = (err as Error).message.slice(0, 300);
        }

        await db.insert(webhookDeliveries).values({
          id: crypto.randomUUID(),
          webhookId: hook.id,
          eventType: type,
          statusCode,
          error,
          durationMs: Date.now() - at,
          createdAt: at,
        });

        const ok = statusCode !== null && statusCode >= 200 && statusCode < 300;
        if (ok || !worthRetrying(statusCode) || attempt === ATTEMPTS) break;
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
      }
      void started;
    }),
  );
}
