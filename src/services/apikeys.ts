import type { Db } from "../db/types";
import { eq } from "drizzle-orm";
import { apiKeys } from "../db/schema";

const PREFIX = "mv_live_";

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Returns the plaintext key exactly once — only its hash is ever persisted. */
export function generateKey(): { plaintext: string; preview: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const body = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const plaintext = `${PREFIX}${body}`;
  return { plaintext, preview: `${PREFIX}${body.slice(0, 4)}…${body.slice(-4)}` };
}

export interface ResolvedKey {
  id: string;
  name: string;
  scope: "full" | "sending";
  restrictMailboxId: string | null;
  /** Tenant the key belongs to; every request it makes is confined to this. */
  orgId: string;
}

/**
 * Look up a bearer token. Constant-time comparison isn't needed here: we hash
 * the presented value and match on an indexed column, so no secret is compared
 * byte by byte against attacker-controlled input.
 */
export async function resolveApiKey(
  db: Db,
  header: string | undefined,
): Promise<ResolvedKey | null> {
  if (!header?.startsWith("Bearer ")) return null;
  const presented = header.slice(7).trim();
  if (!presented.startsWith(PREFIX)) return null;

  const hash = await sha256Hex(presented);
  const row = await db.select().from(apiKeys).where(eq(apiKeys.hash, hash)).get();
  if (!row) return null;

  // Best-effort last-used stamp; never block the request on it.
  await db
    .update(apiKeys)
    .set({ lastUsedAt: Date.now() })
    .where(eq(apiKeys.id, row.id))
    .catch(() => {});

  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    restrictMailboxId: row.restrictMailboxId,
    orgId: row.orgId,
  };
}
