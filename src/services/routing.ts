/**
 * Cloudflare Email Routing rule management, so creating a mailbox in the
 * dashboard actually makes it receive mail.
 *
 * Needs a scoped API token with *Email Routing Rules: Edit* on this zone only.
 * Deliberately not the global key: the blast radius of a leak here is limited
 * to rerouting mail on one zone. When the token is absent every call returns
 * `configured: false` and the UI falls back to telling you to add the rule by
 * hand — nothing breaks, it just isn't automatic.
 */

import { listDomains, zoneForAddress } from "./domains";
import type { Db } from "../db/types";

const API = "https://api.cloudflare.com/client/v4";

export interface RoutingResult {
  configured: boolean;
  ruleId?: string;
  error?: string;
}

function creds(env: Env, zoneId: string): { token: string; zoneId: string } | null {
  const token = env.CF_API_TOKEN;
  if (!token || !zoneId) return null;
  return { token, zoneId };
}

export function routingConfigured(env: Env): boolean {
  return Boolean(env.CF_API_TOKEN);
}

export async function createRoutingRule(
  db: Db,
  env: Env,
  address: string,
): Promise<RoutingResult> {
  const c = creds(env, await zoneForAddress(db, env, address));
  if (!c) return { configured: false };

  try {
    const res = await fetch(`${API}/zones/${c.zoneId}/email/routing/rules`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${c.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: `${address} to Mittova`,
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: address }],
        actions: [{ type: "worker", value: [env.WORKER_NAME] }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as {
      success: boolean;
      result?: { id: string };
      errors?: { message: string }[];
    };
    if (!body.success) {
      return {
        configured: true,
        error: body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`,
      };
    }
    return { configured: true, ruleId: body.result?.id };
  } catch (err) {
    return { configured: true, error: (err as Error).message };
  }
}

export async function deleteRoutingRule(
  db: Db,
  env: Env,
  ruleId: string,
  address: string,
): Promise<RoutingResult> {
  const c = creds(env, await zoneForAddress(db, env, address));
  if (!c) return { configured: false };

  try {
    const res = await fetch(`${API}/zones/${c.zoneId}/email/routing/rules/${ruleId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${c.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    return { configured: true, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    return { configured: true, error: (err as Error).message };
  }
}

/**
 * Find the zone that owns a domain, by name.
 *
 * The zone id is what makes routing rules and sending onboarding automatic, and
 * asking an operator to copy it out of the Cloudflare dashboard is friction for
 * something the API can answer. Returns "" when the token cannot see the zone,
 * which is the same state as never having been given one: the UI falls back to
 * manual instructions rather than failing.
 */
export async function lookupZoneId(env: Env, domain: string): Promise<string> {
  if (!env.CF_API_TOKEN) return "";

  try {
    const res = await fetch(`${API}/zones?name=${encodeURIComponent(domain)}`, {
      headers: { authorization: `Bearer ${env.CF_API_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { success: boolean; result?: { id: string }[] };
    return (body.success && body.result?.[0]?.id) || "";
  } catch {
    return "";
  }
}

/** Is this domain already onboarded onto Email Sending, and switched on? */
async function sendingEnabled(env: Env, domain: string, zoneId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API}/zones/${zoneId}/email/sending/subdomains`, {
      headers: { authorization: `Bearer ${env.CF_API_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as {
      success: boolean;
      result?: { name: string; enabled: boolean }[];
    };
    return Boolean(
      body.success && body.result?.some((s) => s.name.toLowerCase() === domain && s.enabled),
    );
  } catch {
    return false;
  }
}

/**
 * Onboard a domain onto Cloudflare Email Sending.
 *
 * Verified to work with a token holding only Email Sending: Write at account
 * scope: Cloudflare writes the cf-bounce MX, SPF, DKIM and DMARC records itself,
 * so Mittova never needs DNS edit permission of its own.
 *
 * The inbound half cannot be automated the same way. `email/routing/enable`
 * returns 403 even for a token carrying every Email Routing permission group,
 * so enabling Email Routing stays a dashboard step.
 */
export async function enableSending(
  env: Env,
  domain: string,
  zoneId: string,
): Promise<RoutingResult> {
  if (!env.CF_API_TOKEN || !zoneId) return { configured: false };

  try {
    const res = await fetch(`${API}/zones/${zoneId}/email/sending/subdomains`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.CF_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: domain }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { success: boolean; errors?: { message: string }[] };
    if (body.success) return { configured: true };

    // Removing a domain from Mittova does not un-onboard it at Cloudflare, so
    // re-adding one reports "Subdomain already exists". That is the desired end
    // state reached by another route, not a failure. Ask what is actually true
    // rather than trusting the verb.
    if (await sendingEnabled(env, domain, zoneId)) return { configured: true };

    return {
      configured: true,
      error: body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`,
    };
  } catch (err) {
    return { configured: true, error: (err as Error).message };
  }
}

/** Addresses routed to this Worker, across every configured zone. */
export async function listRoutedAddresses(db: Db, env: Env): Promise<Set<string> | null> {
  const zones = [...new Set((await listDomains(db, env)).map((d) => d.zoneId))].filter(Boolean);
  if (!env.CF_API_TOKEN || zones.length === 0) return null;

  const perZone = await Promise.all(zones.map((z) => routedInZone(env, z)));
  if (perZone.every((s) => s === null)) return null;
  return new Set(perZone.flatMap((s) => [...(s ?? [])]));
}

async function routedInZone(env: Env, zoneId: string): Promise<Set<string> | null> {
  const c = creds(env, zoneId);
  if (!c) return null;

  try {
    const res = await fetch(`${API}/zones/${c.zoneId}/email/routing/rules?per_page=200`, {
      headers: { authorization: `Bearer ${c.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as {
      success: boolean;
      result?: {
        enabled: boolean;
        matchers: { field?: string; value?: string }[];
        actions: { type: string; value?: string[] }[];
      }[];
    };
    if (!body.success) return null;

    const routed = new Set<string>();
    for (const rule of body.result ?? []) {
      if (!rule.enabled) continue;
      const toWorker = rule.actions.some(
        (a) => a.type === "worker" && a.value?.includes(env.WORKER_NAME),
      );
      if (!toWorker) continue;
      for (const m of rule.matchers) {
        if (m.field === "to" && m.value) routed.add(m.value.toLowerCase());
      }
    }
    return routed;
  } catch {
    return null;
  }
}
