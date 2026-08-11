import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq } from "drizzle-orm";
import { mailboxes, messages, events } from "../db/schema";
import { resolveApiKey, type ResolvedKey } from "../services/apikeys";
import { checkRateLimit, recordFailure, type Limit } from "../services/ratelimit";
import { sendEmail, SendError } from "../services/send";

/**
 * Bearer-token API for programmatic use, following the conventional shape for
 * a transactional /emails endpoint.
 * Separate from the session-authenticated dashboard API.
 */
const v1 = new Hono<{ Bindings: Env; Variables: { key: ResolvedKey } }>();

/**
 * Per key, per minute.
 *
 * The per-mailbox daily cap already bounds the total, but nothing bounded the
 * rate, so a leaked key could spend a whole day's allowance in seconds — and
 * burst sending is what gets a domain blocked before the cap ever matters.
 * Generous enough that ordinary transactional traffic never notices.
 */
const API_LIMIT: Limit = { max: 120, windowSeconds: 60 };

v1.use("*", async (c, next) => {
  const db = drizzle(c.env.DB);
  const key = await resolveApiKey(db, c.req.header("authorization"));
  if (!key) {
    return c.json(
      { error: { type: "unauthorized", message: "Missing or invalid API key." } },
      401,
      { "www-authenticate": 'Bearer realm="mittova"' },
    );
  }

  // Keyed on the key, not the caller's IP: a key is the thing being rate
  // limited, and one customer behind a shared address should not throttle
  // another.
  const check = await checkRateLimit(c.env.SETTINGS, `api:${key.id}`, API_LIMIT);
  if (!check.allowed) {
    return c.json(
      { error: { type: "rate_limited", message: "Too many requests. Slow down." } },
      429,
      { "retry-after": String(check.retryAfter) },
    );
  }
  await recordFailure(c.env.SETTINGS, `api:${key.id}`, API_LIMIT);

  c.set("key", key);
  await next();
});

v1.post("/emails", async (c) => {
  const db = drizzle(c.env.DB);
  const key = c.get("key");
  const body = await c.req.json<Record<string, unknown>>();

  const asArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : [];

  // A restricted key may only send as the mailbox it is bound to.
  let mailboxId = body.mailboxId as string | undefined;
  let from = body.from as string | undefined;

  if (key.scope === "sending" && key.restrictMailboxId) {
    const bound = await db
      .select()
      .from(mailboxes)
      .where(and(eq(mailboxes.id, key.restrictMailboxId), eq(mailboxes.orgId, key.orgId)))
      .get();
    if (!bound) {
      return c.json(
        { error: { type: "invalid_key", message: "This key's mailbox no longer exists." } },
        400,
      );
    }
    if (from && from.toLowerCase() !== bound.address) {
      return c.json(
        {
          error: {
            type: "forbidden",
            message: `This key may only send as ${bound.address}.`,
          },
        },
        403,
      );
    }
    mailboxId = bound.id;
    from = undefined;
  }

  try {
    const result = await sendEmail(
      db,
      c.env,
      {
        orgId: key.orgId,
        mailboxId,
        from,
        to: asArray(body.to),
        cc: asArray(body.cc),
        bcc: asArray(body.bcc),
        subject: body.subject as string | undefined,
        text: body.text as string | undefined,
        html: body.html as string | undefined,
        // Both spellings: snake_case is the convention for transactional email
        // REST APIs, camelCase is what the rest of this endpoint uses.
        replyTo: (body.reply_to ?? body.replyTo) as string | undefined,
        replyToMessageId: body.replyToMessageId as string | undefined,
        template: body.template as string | undefined,
        variables: body.variables as Record<string, string> | undefined,
      },
      c.executionCtx,
    );
    return c.json({ id: result.id, messageId: result.messageId }, 201);
  } catch (err) {
    if (err instanceof SendError) {
      return c.json(
        { error: { type: err.code ?? "send_failed", message: err.message, ...err.extra } },
        err.status as 400,
      );
    }
    throw err;
  }
});

v1.get("/emails/:id", async (c) => {
  const db = drizzle(c.env.DB);
  // Joined to the mailbox so the key's tenant is part of the lookup. A message
  // in another tenant reads as absent rather than forbidden, so the response
  // does not confirm that it exists.
  const row = await db
    .select({ msg: messages })
    .from(messages)
    .innerJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
    .where(and(eq(messages.id, c.req.param("id")), eq(mailboxes.orgId, c.get("key").orgId)))
    .get();
  if (!row) {
    return c.json({ error: { type: "not_found", message: "No such message." } }, 404);
  }
  const msg = row.msg;
  const timeline = await db
    .select()
    .from(events)
    .where(eq(events.messageId, msg.id))
    .orderBy(events.createdAt)
    .all();

  return c.json({
    id: msg.id,
    messageId: msg.rfcMessageId,
    direction: msg.direction,
    from: msg.fromAddr,
    to: msg.toAddr,
    cc: msg.ccAddr,
    subject: msg.subject,
    text: msg.bodyText,
    html: msg.bodyHtml,
    createdAt: new Date(msg.createdAt).toISOString(),
    events: timeline.map((e) => ({
      type: e.type,
      detail: e.detail,
      at: new Date(e.createdAt).toISOString(),
    })),
  });
});

v1.get("/emails", async (c) => {
  const db = drizzle(c.env.DB);
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
  const rows = await db
    .select({
      id: messages.id,
      messageId: messages.rfcMessageId,
      direction: messages.direction,
      from: messages.fromAddr,
      to: messages.toAddr,
      subject: messages.subject,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
    .where(eq(mailboxes.orgId, c.get("key").orgId))
    .orderBy(desc(messages.createdAt))
    .limit(limit)
    .all();

  return c.json({
    data: rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt).toISOString() })),
  });
});

export default v1;
