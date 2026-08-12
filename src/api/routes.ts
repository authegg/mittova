import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq, gt, inArray, like, lt, or, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  mailboxes,
  messages,
  attachments,
  events,
  apiKeys,
  webhooks,
  webhookDeliveries,
  templates,
  templateVersions,
  contacts,
  suppressions,
  users,
  userMailboxes,
  messageReads,
  drafts,
  auditLog,
  organizations,
  domains as domainsTable,
} from "../db/schema";
import {
  login,
  logout,
  resolveScope,
  requireAuth,
  requireOwner,
  requirePlatformAdmin,
  canUseMailbox,
  startSession,
  type Scope,
} from "../auth";
import { sendEmail, SendError } from "../services/send";
import {
  addDomain,
  checkDomain,
  listDomains,
  listOrgs,
  removeDomain,
  setZoneId,
} from "../services/domains";
import { generateKey, sha256Hex } from "../services/apikeys";
import { sanitiseEmailHtml } from "../services/html";
import { audit, type AuditAction } from "../services/audit";
import { suppress } from "../services/bounce";
import { exportOrg, listBackups, runBackup } from "../services/backup";
import {
  checkRateLimit,
  clearRateLimit,
  clientIp,
  recordFailure,
  type Limit,
} from "../services/ratelimit";
import { hashPassword, passwordProblem } from "../services/password";
import {
  createRoutingRule,
  deleteRoutingRule,
  enableSending,
  listRoutedAddresses,
  lookupZoneId,
  routingConfigured,
} from "../services/routing";

type Env2 = { Bindings: Env };
const api = new Hono<Env2>();

/**
 * A malformed field is the caller's mistake, so it answers 400 rather than
 * falling through to the 500 an uncaught throw would produce. Registered once
 * so every route that validates with str() gets it.
 */
api.onError((err, c) => {
  if (err instanceof BadField) return c.json({ error: err.message }, 400);
  throw err;
});

const DAY = 24 * 60 * 60 * 1000;

/**
 * Turn free text into a safe FTS5 MATCH expression. Raw input cannot go in:
 * bare quotes, `*` or `NEAR` are FTS syntax and throw on malformed input.
 * Each token is quoted and given a prefix wildcard, then ANDed.
 */
function ftsMatch(raw: string): string | null {
  const tokens = raw.match(/[\p{L}\p{N}@._+-]+/gu) ?? [];
  if (tokens.length === 0) return null;
  return tokens
    .slice(0, 12)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(" AND ");
}

/**
 * SQL predicate restricting a query to the mailboxes this caller may see.
 * Returns undefined only for a platform administrator looking across tenants,
 * and a never-true predicate for anyone with no mailboxes — never "no filter",
 * which would leak everything.
 */
function mailboxFilter(scope: Scope, column: AnySQLiteColumn = messages.mailboxId) {
  if (scope.mailboxIds === "all") return undefined;
  if (scope.mailboxIds.length === 0) return sql`1 = 0`;
  return inArray(column, scope.mailboxIds);
}

/**
 * SQL predicate restricting a query to the caller's tenant.
 *
 * Same shape and the same inversion guard as mailboxFilter: undefined means
 * "across all tenants" and is reachable only by a platform administrator who
 * has not selected one. A caller who somehow has no org denies everything
 * rather than falling through to no filter.
 */
function orgFilter(scope: Scope, column: AnySQLiteColumn) {
  if (scope.orgId) return eq(column, scope.orgId);
  return scope.isPlatformAdmin ? undefined : sql`1 = 0`;
}

/**
 * The tenant a new row belongs to, or null when there is no unambiguous answer.
 *
 * A platform administrator viewing every org at once has no implied tenant, so
 * a write asks them to pick. It deliberately does not accept a tenant from the
 * client: this is the one place six routes agree on where a row lands, and a
 * helper whose safety depends on each caller validating first stops being worth
 * auditing. An action derived from an existing row — duplicating a template —
 * takes the tenant from that row on the server instead.
 */
function writeOrg(scope: Scope): string | null {
  return scope.orgId || null;
}

/**
 * Which of `ids` are mailboxes belonging to `orgId`.
 *
 * Mailbox assignment is bounded by the account's own tenant, never by what the
 * caller happens to be able to reach. canUseMailbox answers a different
 * question — may this caller touch this mailbox — and for a platform
 * administrator viewing every tenant at once the answer is yes to all of them.
 * Filtering assignment through it therefore let an edit made from the "All
 * organizations" view hand one tenant's mailbox to another tenant's user, which
 * stuck: the row was written and the account really could read that mail.
 *
 * Deriving the boundary from the target account instead makes the caller's
 * vantage point irrelevant, which is the property worth having.
 */
async function mailboxesInOrg(
  db: ReturnType<typeof drizzle>,
  ids: string[],
  orgId: string | null,
): Promise<string[]> {
  if (!orgId || ids.length === 0) return [];
  const rows = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(inArray(mailboxes.id, ids), eq(mailboxes.orgId, orgId)))
    .all();
  return rows.map((r) => r.id);
}

/**
 * Long enough that a person can act on it in their own time, short enough that
 * a forgotten invite in an inbox is not a standing way in.
 */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 32 random bytes, hex. Unguessable, and never stored in this form. */
function generateInviteToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const PICK_ORG = {
  error: "Choose an organization in the switcher first, so this belongs to one.",
} as const;

const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A trimmed string field, or undefined when the caller omitted it.
 *
 * Throws for a present-but-wrong type rather than ignoring it: silently
 * dropping `{"fromAddress": 1}` answers 200 and changes nothing, which is a
 * worse thing to debug than being told the field was wrong.
 */
class BadField extends Error {}

function str(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new BadField(`${field} must be a string.`);
  return v.trim();
}

/**
 * A mailbox's standing Reply-To. Empty is meaningful — it means reply to the
 * mailbox itself — so it is a valid value rather than a missing one.
 */
function replyToProblem(value: string): string | null {
  if (value === "") return null;
  return ADDRESS_RE.test(value) ? null : "Enter a valid reply-to address, or leave it blank.";
}

/**
 * Read state is per user once you have accounts: on a shared desk the first
 * person to open a message must not mark it read for everyone. The break-glass
 * admin has no user row, so it falls back to the account-wide column.
 */
function seenExpr(scope: Scope) {
  if (!scope.userId) return messages.seen;
  return sql<number>`(case when exists (
    select 1 from message_reads r
    where r.message_id = ${messages.id} and r.user_id = ${scope.userId}
  ) then 1 else 0 end)`;
}

/* ---------------------------------------------------------------- auth --- */

/**
 * Two windows: a tight one per account so a single address cannot be ground
 * down, and a looser one per IP so a spray across many addresses still trips.
 */
const LOGIN_LIMIT_ACCOUNT: Limit = { max: 8, windowSeconds: 15 * 60 };
const LOGIN_LIMIT_IP: Limit = { max: 30, windowSeconds: 15 * 60 };

api.post("/auth/login", async (c) => {
  const { email, password } = await c.req.json<{ email?: string; password?: string }>();
  if (!password) return c.json({ error: "Password is required." }, 400);

  const account = (email ?? "__admin__").trim().toLowerCase();
  const ip = clientIp(c.req.raw);
  const keys: [string, Limit][] = [
    [`login:acct:${account}`, LOGIN_LIMIT_ACCOUNT],
    [`login:ip:${ip}`, LOGIN_LIMIT_IP],
  ];

  for (const [key, limit] of keys) {
    const check = await checkRateLimit(c.env.SETTINGS, key, limit);
    if (!check.allowed) {
      return c.json({ error: "Too many sign-in attempts. Try again later." }, 429, {
        "retry-after": String(check.retryAfter),
      });
    }
  }

  const result = await login(c, email, password);
  if (!result.ok) {
    await Promise.all(keys.map(([key, limit]) => recordFailure(c.env.SETTINGS, key, limit)));
    return c.json({ error: result.reason }, 401);
  }

  // A success clears the window so a forgetful morning does not lock someone out.
  await Promise.all(keys.map(([key]) => clearRateLimit(c.env.SETTINGS, key)));
  return c.json({ ok: true });
});

api.post("/auth/logout", async (c) => {
  await logout(c);
  return c.json({ ok: true });
});

api.get("/auth/me", async (c) => {
  const scope = await resolveScope(c);
  return c.json({
    authed: scope !== null,
    appName: c.env.APP_NAME,
    domains: scope
      ? (await listDomains(drizzle(c.env.DB), c.env, scope.orgId || undefined)).map((d) => d.domain)
      : [],
    user: scope && {
      email: scope.email,
      name: scope.name,
      role: scope.role,
      isRootAdmin: scope.isRootAdmin,
      isPlatformAdmin: scope.isPlatformAdmin,
      orgId: scope.orgId,
      mustChangePassword: scope.mustChangePassword,
      mailboxCount: scope.mailboxIds === "all" ? null : scope.mailboxIds.length,
      signature: scope.signature,
    },
    routingAutomated: routingConfigured(c.env),
  });
});

/**
 * Accept an invite: set a password and sign in.
 *
 * Unauthenticated by necessity — the whole point is that the person has no
 * credentials yet. The token is the credential, it is matched on a hash, and it
 * is cleared on use so a forwarded invite mail cannot be replayed.
 */
api.post("/auth/accept", async (c) => {
  const { token, password } = await c.req.json<{ token?: string; password?: string }>();
  if (!token) return c.json({ error: "This invite link is missing its token." }, 400);

  const problem = passwordProblem(password ?? "");
  if (problem) return c.json({ error: problem }, 400);

  // Rate limited like a sign-in: the token is long, but an endpoint that turns
  // a guess into an account is worth the same care as one that turns a guess
  // into a session.
  const ip = clientIp(c.req.raw);
  const check = await checkRateLimit(c.env.SETTINGS, `accept:ip:${ip}`, LOGIN_LIMIT_IP);
  if (!check.allowed) {
    return c.json({ error: "Too many attempts. Try again later." }, 429, {
      "retry-after": String(check.retryAfter),
    });
  }

  const db = drizzle(c.env.DB);
  const user = await db
    .select()
    .from(users)
    .where(eq(users.inviteHash, await sha256Hex(token)))
    .get();

  // One message for every failure: a distinct "expired" would confirm that a
  // guessed token had once been real.
  const invalid = () => {
    void recordFailure(c.env.SETTINGS, `accept:ip:${ip}`, LOGIN_LIMIT_IP);
    return c.json({ error: "This invite is no longer valid. Ask for a new one." }, 400);
  };
  if (!user || user.disabled) return invalid();
  if (!user.inviteExpiresAt || user.inviteExpiresAt < Date.now()) return invalid();

  await db
    .update(users)
    .set({
      ...(await hashPassword(password!)),
      mustChangePassword: 0,
      // Cleared, not just expired: an invite is single use.
      inviteHash: null,
      inviteExpiresAt: null,
      lastLoginAt: Date.now(),
    })
    .where(eq(users.id, user.id));

  await startSession(c, user.id);
  return c.json({ ok: true, email: user.email });
});

/** Who an invite is for, so the page can greet them before they commit. */
api.get("/auth/invite/:token", async (c) => {
  const db = drizzle(c.env.DB);
  const user = await db
    .select({ email: users.email, name: users.name, expiresAt: users.inviteExpiresAt })
    .from(users)
    .where(eq(users.inviteHash, await sha256Hex(c.req.param("token"))))
    .get();

  if (!user || !user.expiresAt || user.expiresAt < Date.now()) {
    return c.json({ error: "This invite is no longer valid." }, 404);
  }
  return c.json({ email: user.email, name: user.name });
});

/** Issue a fresh invite, for one that expired or never arrived. */
api.post("/users/:id/invite", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const target = await db
    .select()
    .from(users)
    .where(and(eq(users.id, c.req.param("id")), orgFilter(scope, users.orgId)))
    .get();
  if (!target) return c.json({ error: "Not found." }, 404);

  const token = generateInviteToken();
  await db
    .update(users)
    .set({ inviteHash: await sha256Hex(token), inviteExpiresAt: Date.now() + INVITE_TTL_MS })
    .where(eq(users.id, target.id));
  audit(db, scope, "user.invite", target.email, "", c.executionCtx);
  return c.json({ inviteToken: token, email: target.email });
});

/** Change your own password. Available to any signed-in user. */
api.post("/auth/password", requireAuth, async (c) => {
  const scope = c.get("scope");
  if (scope.isRootAdmin) {
    return c.json(
      { error: "The break-glass administrator password is changed with `wrangler secret put`." },
      400,
    );
  }
  const { password } = await c.req.json<{ password?: string }>();
  const problem = passwordProblem(password ?? "");
  if (problem) return c.json({ error: problem }, 400);

  const db = drizzle(c.env.DB);
  await db
    .update(users)
    .set({ ...(await hashPassword(password!)), mustChangePassword: 0 })
    .where(eq(users.id, scope.userId!));
  return c.json({ ok: true });
});

/** Your own signature, appended when you compose. */
api.post("/auth/signature", requireAuth, async (c) => {
  const scope = c.get("scope");
  if (!scope.userId) {
    return c.json({ error: "The break-glass administrator has no profile to edit." }, 400);
  }
  const { signature } = await c.req.json<{ signature?: string }>();
  const db = drizzle(c.env.DB);
  await db
    .update(users)
    .set({ signature: sanitiseEmailHtml(signature ?? "") })
    .where(eq(users.id, scope.userId));
  return c.json({ ok: true });
});

// Data routes: any signed-in user, results filtered to their mailboxes.
for (const p of ["mailboxes", "messages", "attachments", "send", "stats", "drafts"]) {
  api.use(`/${p}`, requireAuth);
  api.use(`/${p}/*`, requireAuth);
}
// Account administration: owners only.
for (const p of [
  "domains",
  "api-keys",
  "webhooks",
  "templates",
  "contacts",
  "suppressions",
  "users",
  "audit",
]) {
  api.use(`/${p}`, requireOwner);
  api.use(`/${p}/*`, requireOwner);
}
// Platform administration: crosses the tenant boundary, so an org owner is not
// enough. A backup is a dump of every tenant's data in one file.
api.use("/backups", requirePlatformAdmin);
api.use("/backups/*", requirePlatformAdmin);
api.use("/orgs", requirePlatformAdmin);
api.use("/orgs/*", requirePlatformAdmin);

/* ----------------------------------------------------------- mailboxes --- */

api.get("/mailboxes", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);

  const all = await db.select().from(mailboxes).orderBy(mailboxes.address).all();
  const visible =
    scope.mailboxIds === "all" ? all : all.filter((m) => scope.mailboxIds.includes(m.id));

  const since = Date.now() - DAY;
  const counts = await db
    .select({
      mailboxId: messages.mailboxId,
      unread: sql<number>`sum(case when ${messages.direction} = 'in' and ${seenExpr(scope)} = 0 then 1 else 0 end)`,
      sent24h: sql<number>`sum(case when ${messages.direction} = 'out' and ${messages.createdAt} >= ${since} then 1 else 0 end)`,
      received: sql<number>`sum(case when ${messages.direction} = 'in' then 1 else 0 end)`,
      sent: sql<number>`sum(case when ${messages.direction} = 'out' then 1 else 0 end)`,
    })
    .from(messages)
    .groupBy(messages.mailboxId)
    .all();

  const byId = new Map(counts.map((r) => [r.mailboxId, r]));
  // Owners see whether each address is actually wired up in Cloudflare.
  const routed = scope.role === "owner" ? await listRoutedAddresses(db, c.env) : null;

  return c.json(
    visible.map((m) => ({
      ...m,
      unread: Number(byId.get(m.id)?.unread ?? 0),
      sent24h: Number(byId.get(m.id)?.sent24h ?? 0),
      received: Number(byId.get(m.id)?.received ?? 0),
      sent: Number(byId.get(m.id)?.sent ?? 0),
      routed: routed ? routed.has(m.address) : null,
    })),
  );
});

api.post("/mailboxes", requireOwner, async (c) => {
  const body = await c.req.json<{
    address?: string;
    domain?: string;
    name?: string;
    dailySendLimit?: number;
    replyTo?: string;
  }>();
  const local = (body.address ?? "").trim().toLowerCase().split("@")[0];
  if (!/^[a-z0-9._%+-]+$/.test(local)) {
    return c.json({ error: "Use the local part only, for example 'support'." }, 400);
  }

  const scope = c.get("scope");
  const org = writeOrg(scope);
  if (!org) return c.json(PICK_ORG, 400);

  const db = drizzle(c.env.DB);
  // Scoped to the caller's own org, so a mailbox can only ever be created on a
  // domain that tenant owns.
  const domains = (await listDomains(db, c.env, org)).map((d) => d.domain);
  const domain = (body.domain ?? domains[0] ?? "").trim().toLowerCase();
  if (!domains.includes(domain)) {
    return c.json(
      { error: `${domain || "That domain"} is not configured on this deployment.` },
      400,
    );
  }
  const address = `${local}@${domain}`;

  if (await db.select().from(mailboxes).where(eq(mailboxes.address, address)).get()) {
    return c.json({ error: `${address} already exists.` }, 409);
  }

  // Create the row first: mail arriving before the row exists is rejected 550.
  const row = {
    id: crypto.randomUUID(),
    address,
    name: body.name?.trim() || local,
    dailySendLimit: Number.isFinite(body.dailySendLimit) ? Number(body.dailySendLimit) : 200,
    routingRuleId: null as string | null,
    replyTo: (body.replyTo ?? "").trim(),
    orgId: org,
    createdAt: Date.now(),
  };
  const replyProblem = replyToProblem(row.replyTo);
  if (replyProblem) return c.json({ error: replyProblem }, 400);
  await db.insert(mailboxes).values(row);
  audit(db, c.get("scope"), "mailbox.create", address, "", c.executionCtx);

  const routing = await createRoutingRule(db, c.env, address);
  if (routing.ruleId) {
    row.routingRuleId = routing.ruleId;
    await db
      .update(mailboxes)
      .set({ routingRuleId: routing.ruleId })
      .where(eq(mailboxes.id, row.id));
  }

  return c.json({ ...row, routing }, 201);
});

api.patch("/mailboxes/:id", requireOwner, async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{ name?: string; dailySendLimit?: number; replyTo?: string }>();
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string") patch.name = body.name.trim();
  if (Number.isFinite(body.dailySendLimit)) patch.dailySendLimit = Number(body.dailySendLimit);
  if (typeof body.replyTo === "string") {
    const replyTo = body.replyTo.trim();
    const problem = replyToProblem(replyTo);
    if (problem) return c.json({ error: problem }, 400);
    patch.replyTo = replyTo;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "Nothing to update." }, 400);

  // Scoped in the WHERE rather than checked after the fact, so a mailbox in
  // another tenant simply does not match and cannot be written to.
  const target = and(eq(mailboxes.id, id), orgFilter(scope, mailboxes.orgId));
  if (!(await db.select({ id: mailboxes.id }).from(mailboxes).where(target).get())) {
    return c.json({ error: "Not found." }, 404);
  }

  await db.update(mailboxes).set(patch).where(target);
  audit(db, scope, "mailbox.update", id, Object.keys(patch).join(", "), c.executionCtx);
  return c.json(await db.select().from(mailboxes).where(target).get());
});

api.delete("/mailboxes/:id", requireOwner, async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const mailbox = await db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.id, id), orgFilter(scope, mailboxes.orgId)))
    .get();
  if (!mailbox) return c.json({ error: "Not found." }, 404);

  // Drop the routing rule first, so mail stops arriving for an address whose
  // row is about to disappear.
  let routing;
  if (mailbox.routingRuleId)
    routing = await deleteRoutingRule(db, c.env, mailbox.routingRuleId, mailbox.address);

  await db.delete(mailboxes).where(eq(mailboxes.id, id));
  audit(db, c.get("scope"), "mailbox.delete", mailbox.address, "", c.executionCtx);
  return c.json({ ok: true, routing });
});

/* ------------------------------------------------------------ messages --- */

api.get("/messages", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const q = c.req.query("q");
  const mailboxId = c.req.query("mailboxId");
  const direction = c.req.query("direction");
  const unreadOnly = c.req.query("unread") === "1";
  const before = Number(c.req.query("before") ?? 0);
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);

  const filters = [];
  const permission = mailboxFilter(scope);
  if (permission) filters.push(permission);

  if (mailboxId) {
    if (!canUseMailbox(scope, mailboxId)) return c.json({ error: "forbidden" }, 403);
    filters.push(eq(messages.mailboxId, mailboxId));
  }
  if (direction === "in" || direction === "out") filters.push(eq(messages.direction, direction));
  if (c.req.query("needsReply") === "1") {
    filters.push(eq(messages.direction, "in"));
    filters.push(
      sql`${messages.createdAt} = (select max(m2.created_at) from messages m2 where m2.thread_id = ${messages.threadId})`,
    );
  }
  if (unreadOnly) filters.push(sql`${seenExpr(scope)} = 0`);

  const view = c.req.query("view");
  if (view === "archived") filters.push(eq(messages.archived, 1));
  else if (view === "starred") filters.push(eq(messages.starred, 1));
  else filters.push(eq(messages.archived, 0));
  if (before > 0) filters.push(lt(messages.createdAt, before));

  if (c.req.query("assigned") === "me" && scope.userId) {
    filters.push(eq(messages.assignedToUserId, scope.userId));
  } else if (c.req.query("assigned") === "none") {
    filters.push(sql`${messages.assignedToUserId} is null`);
  }

  if (q) {
    // FTS5 where the query tokenises, LIKE only as a fallback for input that
    // produces no usable tokens (for example a lone punctuation mark).
    const match = ftsMatch(q);
    if (match) {
      filters.push(
        sql`${messages.id} in (select mid from messages_fts where messages_fts match ${match})`,
      );
    } else {
      const needle = `%${q}%`;
      filters.push(
        or(
          like(messages.subject, needle),
          like(messages.fromAddr, needle),
          like(messages.toAddr, needle),
          like(messages.snippet, needle),
        )!,
      );
    }
  }

  const rows = await db
    .select({
      id: messages.id,
      mailboxId: messages.mailboxId,
      mailboxAddress: mailboxes.address,
      direction: messages.direction,
      threadId: messages.threadId,
      fromAddr: messages.fromAddr,
      fromName: messages.fromName,
      toAddr: messages.toAddr,
      subject: messages.subject,
      snippet: messages.snippet,
      spf: messages.spf,
      dkim: messages.dkim,
      dmarc: messages.dmarc,
      seen: seenExpr(scope),
      assignedToUserId: messages.assignedToUserId,
      archived: messages.archived,
      starred: messages.starred,
      size: messages.size,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(messages.createdAt))
    .limit(limit)
    .all();

  return c.json({
    messages: rows,
    nextBefore: rows.length === limit ? rows[rows.length - 1].createdAt : null,
  });
});

api.get("/messages/:id", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const msg = await db.select().from(messages).where(eq(messages.id, id)).get();
  // Same 404 whether it is missing or forbidden: existence is itself a leak.
  if (!msg || !canUseMailbox(scope, msg.mailboxId)) return c.json({ error: "Not found." }, 404);

  // Mark read for this person only; the global flag stays for the admin login.
  if (scope.userId) {
    await db
      .insert(messageReads)
      .values({ userId: scope.userId, messageId: id, readAt: Date.now() })
      .onConflictDoNothing();
  } else if (!msg.seen) {
    await db.update(messages).set({ seen: 1 }).where(eq(messages.id, id));
  }
  msg.seen = 1;

  const [atts, timeline, thread] = await Promise.all([
    db.select().from(attachments).where(eq(attachments.messageId, id)).all(),
    db.select().from(events).where(eq(events.messageId, id)).orderBy(events.createdAt).all(),
    db
      .select({
        id: messages.id,
        direction: messages.direction,
        fromAddr: messages.fromAddr,
        toAddr: messages.toAddr,
        subject: messages.subject,
        snippet: messages.snippet,
        createdAt: messages.createdAt,
        mailboxId: messages.mailboxId,
      })
      .from(messages)
      .where(eq(messages.threadId, msg.threadId))
      .orderBy(messages.createdAt)
      .all(),
  ]);

  // Who could this be handed to: everyone with access to the same mailbox.
  const assignable = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .innerJoin(userMailboxes, eq(userMailboxes.userId, users.id))
    .where(and(eq(userMailboxes.mailboxId, msg.mailboxId), eq(users.disabled, 0)))
    .all();

  return c.json({
    message: msg,
    assignable,
    attachments: atts,
    events: timeline,
    // A thread can span mailboxes; only show the parts this caller may read.
    thread: thread.filter((t) => canUseMailbox(scope, t.mailboxId)),
  });
});

api.post("/messages/:id/unread", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const msg = await db
    .select()
    .from(messages)
    .where(eq(messages.id, c.req.param("id")))
    .get();
  if (!msg || !canUseMailbox(scope, msg.mailboxId)) return c.json({ error: "Not found." }, 404);

  if (scope.userId) {
    await db
      .delete(messageReads)
      .where(and(eq(messageReads.userId, scope.userId), eq(messageReads.messageId, msg.id)));
  } else {
    await db.update(messages).set({ seen: 0 }).where(eq(messages.id, msg.id));
  }
  return c.json({ ok: true });
});

/** Archive or star without deleting. */
api.post("/messages/:id/flag", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const { archived, starred } = await c.req.json<{ archived?: boolean; starred?: boolean }>();
  const patch: Record<string, number> = {};
  if (typeof archived === "boolean") patch.archived = archived ? 1 : 0;
  if (typeof starred === "boolean") patch.starred = starred ? 1 : 0;
  if (Object.keys(patch).length === 0) return c.json({ error: "Nothing to update." }, 400);

  // Authorise inside the WHERE rather than reading the row first: a SELECT *
  // would drag the whole message body across the wire to toggle one flag.
  const permission = mailboxFilter(scope);
  const result = await db
    .update(messages)
    .set(patch)
    .where(
      permission
        ? and(eq(messages.id, c.req.param("id")), permission)
        : eq(messages.id, c.req.param("id")),
    )
    .run();

  if (result.meta.changes === 0) return c.json({ error: "Not found." }, 404);
  return c.json({ ok: true, ...patch });
});

/** Claim a message, hand it to a colleague, or clear the assignment. */
api.post("/messages/:id/assign", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const msg = await db
    .select()
    .from(messages)
    .where(eq(messages.id, c.req.param("id")))
    .get();
  if (!msg || !canUseMailbox(scope, msg.mailboxId)) return c.json({ error: "Not found." }, 404);

  const { userId } = await c.req.json<{ userId?: string | null }>();
  if (userId) {
    const target = await db.select().from(users).where(eq(users.id, userId)).get();
    if (!target) return c.json({ error: "No such user." }, 400);
  }
  await db
    .update(messages)
    .set({ assignedToUserId: userId ?? null })
    .where(eq(messages.id, msg.id));
  return c.json({ ok: true, assignedToUserId: userId ?? null });
});

api.delete("/messages/:id", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const msg = await db.select().from(messages).where(eq(messages.id, id)).get();
  if (!msg || !canUseMailbox(scope, msg.mailboxId)) return c.json({ error: "Not found." }, 404);

  if (msg.rawKey) await c.env.STORAGE.delete(msg.rawKey);
  const atts = await db.select().from(attachments).where(eq(attachments.messageId, id)).all();
  await Promise.all(atts.map((a) => c.env.STORAGE.delete(a.r2Key)));
  await db.delete(messages).where(eq(messages.id, id));
  audit(db, scope, "message.delete", msg.subject.slice(0, 80), "", c.executionCtx);
  return c.json({ ok: true });
});

api.get("/messages/:id/raw", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const msg = await db
    .select()
    .from(messages)
    .where(eq(messages.id, c.req.param("id")))
    .get();
  if (!msg || !canUseMailbox(scope, msg.mailboxId)) return c.json({ error: "Not found." }, 404);
  if (!msg.rawKey) return c.json({ error: "No raw source stored for this message." }, 404);

  const object = await c.env.STORAGE.get(msg.rawKey);
  if (!object) return c.json({ error: "Raw source missing from R2." }, 404);
  return new Response(object.body, { headers: { "content-type": "text/plain; charset=utf-8" } });
});

api.get("/attachments/:id", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const att = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, c.req.param("id")))
    .get();
  if (!att) return c.json({ error: "Not found." }, 404);

  // Authorise via the parent message's mailbox, not the attachment id alone.
  const parent = await db.select().from(messages).where(eq(messages.id, att.messageId)).get();
  if (!parent || !canUseMailbox(scope, parent.mailboxId))
    return c.json({ error: "Not found." }, 404);

  const object = await c.env.STORAGE.get(att.r2Key);
  if (!object) return c.json({ error: "Object missing from R2." }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": att.mimeType,
      "content-disposition": `attachment; filename="${att.filename.replace(/"/g, "")}"`,
    },
  });
});

/* ---------------------------------------------------------------- send --- */

api.post("/send", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const body = await c.req.json<Record<string, unknown>>();
  const asArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : [];

  const mailboxId = body.mailboxId as string | undefined;
  if (!mailboxId || !canUseMailbox(scope, mailboxId)) {
    return c.json({ error: "You cannot send from that mailbox." }, 403);
  }

  try {
    const result = await sendEmail(
      db,
      c.env,
      {
        orgId: scope.orgId || undefined,
        mailboxId,
        to: asArray(body.to),
        cc: asArray(body.cc),
        bcc: asArray(body.bcc),
        subject: body.subject as string | undefined,
        text: body.text as string | undefined,
        html: body.html as string | undefined,
        replyTo: body.replyTo as string | undefined,
        replyToMessageId: body.replyToMessageId as string | undefined,
        template: body.template as string | undefined,
        variables: body.variables as Record<string, string> | undefined,
        attachments: body.attachments as
          { filename: string; content: string; type?: string }[] | undefined,
      },
      c.executionCtx,
    );
    return c.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof SendError) {
      return c.json({ error: err.message, code: err.code, ...err.extra }, err.status as 400);
    }
    throw err;
  }
});

/* --------------------------------------------------------------- stats --- */

api.get("/stats", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const days = Math.min(Number(c.req.query("days") ?? 14), 90);
  const since = Date.now() - days * DAY;
  const permission = mailboxFilter(scope);

  const [totals] = await db
    .select({
      total: sql<number>`count(*)`,
      inbound: sql<number>`sum(case when ${messages.direction} = 'in' then 1 else 0 end)`,
      outbound: sql<number>`sum(case when ${messages.direction} = 'out' then 1 else 0 end)`,
      unread: sql<number>`sum(case when ${messages.direction} = 'in' and ${seenExpr(scope)} = 0 then 1 else 0 end)`,
      dmarcPass: sql<number>`sum(case when ${messages.dmarc} = 'pass' then 1 else 0 end)`,
      needsReply: sql<number>`sum(case when ${messages.direction} = 'in' and ${messages.createdAt} = (select max(m2.created_at) from messages m2 where m2.thread_id = ${messages.threadId}) then 1 else 0 end)`,
      authChecked: sql<number>`sum(case when ${messages.direction} = 'in' and ${messages.dmarc} is not null then 1 else 0 end)`,
    })
    .from(messages)
    .where(permission)
    .all();

  const series = await db
    .select({
      day: sql<string>`date(${messages.createdAt} / 1000, 'unixepoch')`,
      inbound: sql<number>`sum(case when ${messages.direction} = 'in' then 1 else 0 end)`,
      outbound: sql<number>`sum(case when ${messages.direction} = 'out' then 1 else 0 end)`,
    })
    .from(messages)
    .where(
      permission ? and(permission, gt(messages.createdAt, since)) : gt(messages.createdAt, since),
    )
    .groupBy(sql`date(${messages.createdAt} / 1000, 'unixepoch')`)
    .all();

  const byDay = new Map(series.map((r) => [r.day, r]));
  const filled: { day: string; inbound: number; outbound: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * DAY).toISOString().slice(0, 10);
    const row = byDay.get(day);
    filled.push({ day, inbound: Number(row?.inbound ?? 0), outbound: Number(row?.outbound ?? 0) });
  }

  /**
   * The same tenant rule `orgFilter` applies, expressed for a raw subquery.
   *
   * These seven were counted across every tenant: the message stats above are
   * scoped by `permission`, and the counts beside them were not, so an owner's
   * "contacts" tile moved when an unrelated client added a contact. No row
   * content escaped, but the totals did, and this is the same shape as the
   * cross-tenant owner count this project has already had once.
   *
   * Fails closed identically: an org scopes to itself, a platform administrator
   * with no org selected sees across all of them, and anyone else matches
   * nothing rather than everything.
   */
  const tenant = scope.orgId
    ? sql`where org_id = ${scope.orgId}`
    : scope.isPlatformAdmin
      ? sql``
      : sql`where 1 = 0`;

  const counts =
    scope.role === "owner"
      ? (
          await db
            .select({
              mailboxes: sql<number>`(select count(*) from mailboxes ${tenant})`,
              keys: sql<number>`(select count(*) from api_keys ${tenant})`,
              hooks: sql<number>`(select count(*) from webhooks ${tenant})`,
              templates: sql<number>`(select count(*) from templates ${tenant})`,
              contacts: sql<number>`(select count(*) from contacts ${tenant})`,
              suppressions: sql<number>`(select count(*) from suppressions ${tenant})`,
              users: sql<number>`(select count(*) from users ${tenant})`,
            })
            .from(sql`(select 1)`)
            .all()
        )[0]
      : undefined;

  return c.json({
    totals: {
      total: Number(totals?.total ?? 0),
      inbound: Number(totals?.inbound ?? 0),
      outbound: Number(totals?.outbound ?? 0),
      unread: Number(totals?.unread ?? 0),
      dmarcPass: Number(totals?.dmarcPass ?? 0),
      needsReply: Number(totals?.needsReply ?? 0),
      authChecked: Number(totals?.authChecked ?? 0),
    },
    counts: {
      mailboxes: Number(counts?.mailboxes ?? 0),
      apiKeys: Number(counts?.keys ?? 0),
      webhooks: Number(counts?.hooks ?? 0),
      templates: Number(counts?.templates ?? 0),
      contacts: Number(counts?.contacts ?? 0),
      suppressions: Number(counts?.suppressions ?? 0),
      users: Number(counts?.users ?? 0),
    },
    series: filled,
  });
});

/* -------------------------------------------------------------- drafts --- */

api.get("/drafts", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  // Filter by mailbox in SQL, not after .limit(50) — otherwise another user's
  // rows can fill the page and hide this user's own drafts.
  const owner = scope.userId ? eq(drafts.userId, scope.userId) : sql`${drafts.userId} is null`;
  const permission = mailboxFilter(scope, drafts.mailboxId);
  return c.json(
    await db
      .select()
      .from(drafts)
      .where(permission ? and(owner, permission) : owner)
      .orderBy(desc(drafts.updatedAt))
      .limit(50)
      .all(),
  );
});

/** Upsert: the composer autosaves against a client-held id. */
api.put("/drafts/:id", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{
    mailboxId?: string;
    to?: string;
    cc?: string;
    bcc?: string;
    subject?: string;
    html?: string;
    replyToMessageId?: string | null;
  }>();

  if (!body.mailboxId || !canUseMailbox(scope, body.mailboxId)) {
    return c.json({ error: "You cannot draft from that mailbox." }, 403);
  }

  const now = Date.now();
  const row = {
    id,
    userId: scope.userId,
    mailboxId: body.mailboxId,
    toAddr: body.to ?? "",
    ccAddr: body.cc ?? "",
    bccAddr: body.bcc ?? "",
    subject: body.subject ?? "",
    bodyHtml: sanitiseEmailHtml(body.html ?? ""),
    replyToMessageId: body.replyToMessageId ?? null,
    updatedAt: now,
    createdAt: now,
  };

  // Upsert: autosave fires every 1.2s while typing, and a read-then-write was
  // two round trips per keystroke burst. createdAt is simply left out of the
  // update, which is all the read-back was preserving.
  const { id: _id, createdAt: _created, ...patch } = row;
  await db
    .insert(drafts)
    .values(row)
    .onConflictDoUpdate({
      target: drafts.id,
      set: patch,
      // Only the owner may overwrite; a mismatched owner updates nothing.
      setWhere: scope.userId ? eq(drafts.userId, scope.userId) : sql`${drafts.userId} is null`,
    });
  return c.json(row);
});

api.delete("/drafts/:id", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const owner = scope.userId ? eq(drafts.userId, scope.userId) : sql`${drafts.userId} is null`;
  await db.delete(drafts).where(and(eq(drafts.id, c.req.param("id")), owner));
  return c.json({ ok: true });
});

/* --------------------------------------------------------------- audit --- */

api.get("/audit", async (c) => {
  const db = drizzle(c.env.DB);
  return c.json(
    await db
      .select()
      .from(auditLog)
      .where(orgFilter(c.get("scope"), auditLog.orgId))
      .orderBy(desc(auditLog.createdAt))
      .limit(200)
      .all(),
  );
});

/* ------------------------------------------------------------- backups --- */

api.get("/backups", async (c) => c.json(await listBackups(c.env)));

api.post("/backups", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const result = await runBackup(c.env);
  audit(db, scope, "backup.run", result.key, `${result.bytes} bytes`, c.executionCtx);
  return c.json(result, 201);
});

/* --------------------------------------------------------------- users --- */

api.get("/users", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      disabled: users.disabled,
      mustChangePassword: users.mustChangePassword,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
      // The account's tenant, which bounds which mailboxes may be assigned to
      // it. The editor needs it to offer the right ones: a platform admin on
      // "All organizations" has no tenant of their own to fall back to.
      orgId: users.orgId,
    })
    .from(users)
    .where(orgFilter(scope, users.orgId))
    .orderBy(users.email)
    .all();

  // Only the listed users' links, so the map cannot carry an assignment
  // belonging to somebody in another tenant.
  const ids = rows.map((u) => u.id);
  const links = ids.length
    ? await db.select().from(userMailboxes).where(inArray(userMailboxes.userId, ids)).all()
    : [];
  const byUser = new Map<string, string[]>();
  for (const l of links) {
    byUser.set(l.userId, [...(byUser.get(l.userId) ?? []), l.mailboxId]);
  }

  return c.json(rows.map((u) => ({ ...u, mailboxIds: byUser.get(u.id) ?? [] })));
});

api.post("/users", async (c) => {
  const scope = c.get("scope");
  const org = writeOrg(scope);
  if (!org) return c.json(PICK_ORG, 400);

  const db = drizzle(c.env.DB);
  const body = await c.req.json<{
    email?: string;
    name?: string;
    role?: "owner" | "member";
    password?: string;
    mailboxIds?: string[];
  }>();

  const email = (body.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "A valid email address is required." }, 400);
  }
  // A password is now optional: without one the account is invited instead, so
  // nobody has to transmit a password to the person it belongs to.
  const invited = !body.password;
  if (!invited) {
    const problem = passwordProblem(body.password!);
    if (problem) return c.json({ error: problem }, 400);
  }
  if (await db.select().from(users).where(eq(users.email, email)).get()) {
    return c.json({ error: `${email} already has an account.` }, 409);
  }

  // An unguessable value the account has no usable password until someone
  // presents. Only its hash is stored, so a leaked database is not a way in.
  const inviteToken = invited ? generateInviteToken() : null;

  const row = {
    id: crypto.randomUUID(),
    email,
    name: body.name?.trim() || email.split("@")[0],
    role: body.role === "owner" ? ("owner" as const) : ("member" as const),
    // An invited account gets a random password nobody knows, so the row is
    // valid but unusable until the invite is accepted.
    ...(await hashPassword(invited ? crypto.randomUUID() + crypto.randomUUID() : body.password!)),
    mustChangePassword: 1,
    disabled: 0,
    orgId: org,
    inviteHash: inviteToken ? await sha256Hex(inviteToken) : null,
    inviteExpiresAt: inviteToken ? Date.now() + INVITE_TTL_MS : null,
    lastLoginAt: null,
    createdAt: Date.now(),
  };
  await db.insert(users).values(row);
  audit(db, scope, "user.create", email, `role ${row.role}`, c.executionCtx);

  // Assignments are confined to the tenant the account itself lands in, so a
  // crafted request cannot grant a new account access to another one.
  const ids = await mailboxesInOrg(db, body.mailboxIds ?? [], org);
  if (ids.length > 0) {
    await db
      .insert(userMailboxes)
      .values(ids.map((mailboxId) => ({ userId: row.id, mailboxId, createdAt: Date.now() })));
  }

  const { passwordHash, passwordSalt, passwordIterations, inviteHash, ...safe } = row;
  // The token is returned once, here, exactly like an API key: it is not
  // recoverable afterwards, and it is not stored in a form that could be.
  return c.json({ ...safe, mailboxIds: ids, inviteToken }, 201);
});

api.patch("/users/:id", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    role?: "owner" | "member";
    disabled?: boolean;
    password?: string;
    mailboxIds?: string[];
  }>();

  const target = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id), orgFilter(scope, users.orgId)))
    .get();
  if (!target) return c.json({ error: "Not found." }, 404);

  // Guard against an owner removing their own access and stranding the account.
  if (scope.userId === id && (body.role === "member" || body.disabled === true)) {
    return c.json({ error: "You cannot demote or disable your own account." }, 400);
  }
  if (target.role === "owner" && (body.role === "member" || body.disabled === true)) {
    // Counted within the target's own org. Counting across every tenant would
    // let the last owner of one client be demoted because a different client
    // still has one, leaving that org with nobody who can administer it.
    const [{ owners }] = await db
      .select({ owners: sql<number>`count(*)` })
      .from(users)
      .where(and(eq(users.role, "owner"), eq(users.disabled, 0), eq(users.orgId, target.orgId)))
      .all();
    if (Number(owners) <= 1) {
      return c.json({ error: "This is the last active owner." }, 400);
    }
  }

  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string") patch.name = body.name.trim();
  if (body.role) patch.role = body.role;
  if (typeof body.disabled === "boolean") patch.disabled = body.disabled ? 1 : 0;
  if (body.password) {
    const problem = passwordProblem(body.password);
    if (problem) return c.json({ error: problem }, 400);
    Object.assign(patch, await hashPassword(body.password), { mustChangePassword: 1 });
  }
  if (Object.keys(patch).length > 0) {
    await db.update(users).set(patch).where(eq(users.id, id));
    const what = [
      ...new Set(Object.keys(patch).map((k) => (k.startsWith("password") ? "password" : k))),
    ].join(", ");
    audit(db, scope, "user.update", target.email, what, c.executionCtx);
  }
  if (body.mailboxIds) {
    // Bounded by the target account's own tenant rather than by the caller's
    // reach: a platform administrator on "All organizations" reaches every
    // mailbox, and filtering by that let this route move one across.
    const allowed = await mailboxesInOrg(db, body.mailboxIds, target.orgId);
    await db.delete(userMailboxes).where(eq(userMailboxes.userId, id));
    if (allowed.length > 0) {
      await db
        .insert(userMailboxes)
        .values(allowed.map((mailboxId) => ({ userId: id, mailboxId, createdAt: Date.now() })));
    }
    // The count that landed, not the count that was asked for. An entry saying
    // three were assigned when the tenant boundary refused two describes an
    // event that did not happen, and this is the trail that would be read to
    // find out whether it did.
    audit(db, scope, "user.mailboxes", target.email, `${allowed.length} assigned`, c.executionCtx);
  }

  return c.json({ ok: true });
});

api.delete("/users/:id", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  if (scope.userId === id) return c.json({ error: "You cannot delete your own account." }, 400);

  const target = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id), orgFilter(scope, users.orgId)))
    .get();
  if (!target) return c.json({ error: "Not found." }, 404);

  if (target.role === "owner") {
    const [{ owners }] = await db
      .select({ owners: sql<number>`count(*)` })
      .from(users)
      .where(and(eq(users.role, "owner"), eq(users.disabled, 0), eq(users.orgId, target.orgId)))
      .all();
    if (Number(owners) <= 1) return c.json({ error: "This is the last active owner." }, 400);
  }

  await db.delete(users).where(eq(users.id, id));
  audit(db, scope, "user.delete", target.email, "", c.executionCtx);
  return c.json({ ok: true });
});

/**
 * Everything belonging to one tenant, as a download.
 *
 * Deliberately not under /orgs: that whole path is platform-administrator only,
 * and an org owner taking their own data is the main case. It exports whichever
 * tenant the caller is in, which for a platform administrator is whichever one
 * they have selected — the same rule every other scoped operation follows.
 *
 * The nightly backup stays platform-only, because it is every client's data in
 * one file.
 */
api.get("/export", requireOwner, async (c) => {
  const scope = c.get("scope");
  const org = writeOrg(scope);
  if (!org) return c.json(PICK_ORG, 400);

  const db = drizzle(c.env.DB);
  const row = await db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, org))
    .get();
  if (!row) return c.json({ error: "Not found." }, 404);

  const body = await exportOrg(c.env, org);
  audit(db, scope, "org.export", org, `${body.length} bytes`, c.executionCtx);

  const day = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson",
      "content-disposition": `attachment; filename="mittova-${row.slug}-${day}.ndjson"`,
    },
  });
});

/* -------------------------------------------------------------- orgs --- */

/**
 * Tenants, with enough of a summary to tell them apart in a switcher.
 *
 * Platform administrators only: an org owner has exactly one org and learns
 * nothing useful from a list, while the list itself is the client roster.
 */
api.get("/orgs", async (c) => {
  const db = drizzle(c.env.DB);
  const [orgs, allDomains, allMailboxes, allUsers, allTemplates] = await Promise.all([
    listOrgs(db),
    db.select({ domain: domainsTable.domain, orgId: domainsTable.orgId }).from(domainsTable).all(),
    db.select({ orgId: mailboxes.orgId }).from(mailboxes).all(),
    db.select({ orgId: users.orgId }).from(users).all(),
    db.select({ orgId: templates.orgId }).from(templates).all(),
  ]);

  return c.json(
    orgs.map((o) => ({
      ...o,
      domains: allDomains.filter((d) => d.orgId === o.id).map((d) => d.domain),
      mailboxes: allMailboxes.filter((m) => m.orgId === o.id).length,
      users: allUsers.filter((u) => u.orgId === o.id).length,
      templates: allTemplates.filter((t) => t.orgId === o.id).length,
    })),
  );
});

/**
 * Onboard a client before it has a domain.
 *
 * Until now an org could only appear as a side effect of adding a domain,
 * which forces the DNS conversation to happen first. A client usually exists
 * before its domain is ready.
 */
api.post("/orgs", async (c) => {
  const db = drizzle(c.env.DB);
  const { name } = await c.req.json<{ name?: string }>();
  const trimmed = str(name, "name") ?? "";
  if (!trimmed) return c.json({ error: "A name is required." }, 400);

  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) return c.json({ error: "The name needs at least one letter or number." }, 400);

  if (
    await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .get()
  ) {
    return c.json({ error: `An organization called '${trimmed}' already exists.` }, 409);
  }

  const row = { id: `org_${slug}`, name: trimmed, slug, createdAt: Date.now() };
  await db.insert(organizations).values(row);
  audit(db, c.get("scope"), "org.create", trimmed, "", c.executionCtx);
  return c.json({ ...row, domains: [], mailboxes: 0, users: 0, templates: 0 }, 201);
});

api.patch("/orgs/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{ name?: string; dailySendLimit?: number }>();

  const existing = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, c.req.param("id")))
    .get();
  if (!existing) return c.json({ error: "Not found." }, 404);

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const trimmed = str(body.name, "name") ?? "";
    if (!trimmed) return c.json({ error: "A name is required." }, 400);
    // The slug is not renamed with it: org ids are derived from the slug and
    // are referenced by every row in the tenant, so this is a label change.
    patch.name = trimmed;
  }
  if (body.dailySendLimit !== undefined) {
    const limit = Number(body.dailySendLimit);
    if (!Number.isInteger(limit) || limit < 0) {
      return c.json({ error: "The daily limit must be zero or a positive whole number." }, 400);
    }
    patch.dailySendLimit = limit;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "Nothing to update." }, 400);

  await db.update(organizations).set(patch).where(eq(organizations.id, existing.id));
  audit(
    db,
    c.get("scope"),
    "org.rename",
    existing.id,
    Object.keys(patch).join(", "),
    c.executionCtx,
  );
  return c.json({ ok: true });
});

/**
 * Remove a tenant, but only an empty one.
 *
 * Deleting an org with rows in it would either orphan them or cascade into
 * somebody's mail. Refusing and saying what is still there is the honest
 * behaviour: the operator can see exactly what to remove first.
 */
api.delete("/orgs/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(organizations).where(eq(organizations.id, id)).get();
  if (!existing) return c.json({ error: "Not found." }, 404);

  const [domainCount, mailboxCount, userCount] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)` })
      .from(domainsTable)
      .where(eq(domainsTable.orgId, id))
      .get(),
    db
      .select({ n: sql<number>`count(*)` })
      .from(mailboxes)
      .where(eq(mailboxes.orgId, id))
      .get(),
    db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(eq(users.orgId, id))
      .get(),
  ]);

  const holding = [
    Number(domainCount?.n ?? 0) && `${domainCount?.n} domain(s)`,
    Number(mailboxCount?.n ?? 0) && `${mailboxCount?.n} mailbox(es)`,
    Number(userCount?.n ?? 0) && `${userCount?.n} user(s)`,
  ].filter(Boolean);

  if (holding.length > 0) {
    return c.json(
      { error: `${existing.name} still has ${holding.join(", ")}. Remove them first.` },
      409,
    );
  }

  await db.delete(organizations).where(eq(organizations.id, id));
  audit(db, c.get("scope"), "org.delete", existing.name, "", c.executionCtx);
  return c.json({ ok: true });
});

api.patch("/orgs/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const { name } = await c.req.json<{ name?: string }>();
  if (!name?.trim()) return c.json({ error: "A name is required." }, 400);

  await db
    .update(organizations)
    .set({ name: name.trim() })
    .where(eq(organizations.id, c.req.param("id")));
  audit(db, c.get("scope"), "org.rename", c.req.param("id"), name.trim(), c.executionCtx);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------- domains --- */

api.get("/domains", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  // Undefined for a platform administrator looking across tenants; otherwise
  // only this org's domains.
  let configured = await listDomains(db, c.env, scope.orgId || undefined);

  // DNS moves on the order of days; 7 DoH lookups per domain on every dashboard
  // mount is pure waste, so results are cached briefly in KV. Re-check DNS sends
  // ?fresh=1, and has to actually re-check or the button is a lie: right after
  // enabling a service the cached answer is the stale pre-enable one.
  const cacheKey = `dns:status:${configured.map((d) => d.domain).join(",")}`;
  const wantsFresh = c.req.query("fresh") === "1";
  if (!wantsFresh) {
    const cached = await c.env.SETTINGS.get(cacheKey, "json");
    if (cached) return c.json(cached);
  }

  // Domains added before their zone was visible, or added by hand, carry no zone
  // id and so get none of the automation. Resolving on a forced re-check is the
  // natural repair point: it is the same button the operator reaches for when a
  // domain looks wrong.
  if (wantsFresh) {
    const resolved = await Promise.all(
      configured.map(async (d) =>
        d.zoneId ? d : { ...d, zoneId: await lookupZoneId(c.env, d.domain) },
      ),
    );
    for (const d of resolved) {
      if (d.zoneId && !configured.find((o) => o.domain === d.domain)?.zoneId) {
        await setZoneId(db, d.domain, d.zoneId);
      }
    }
    configured = resolved;
  }

  const checks = await Promise.all(configured.map((d) => checkDomain(d.domain)));
  const fresh = checks.map((check, i) => ({ ...check, zoneId: configured[i].zoneId }));

  // A fully healthy domain is settled and safe to cache. An unhealthy one is
  // usually a domain onboarded moments ago whose records have not propagated,
  // so caching it for ten minutes strands the operator on a snapshot that was
  // already out of date when it was taken.
  const settled = fresh.every((d) => d.summary.healthy);
  await c.env.SETTINGS.put(cacheKey, JSON.stringify(fresh), {
    expirationTtl: settled ? 600 : 60,
  });
  return c.json(fresh);
});

/**
 * One domain, always freshly resolved.
 *
 * Enabling Email Routing happens in the Cloudflare dashboard, in another tab.
 * This is what the add-domain checklist calls when the operator comes back, so
 * it must never be served from cache and must not pay for checking the domains
 * they are not looking at.
 */
api.get("/domains/:domain", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const domain = c.req.param("domain").toLowerCase();
  const configured = (await listDomains(db, c.env, scope.orgId || undefined)).find(
    (d) => d.domain === domain,
  );
  if (!configured) return c.json({ error: `${domain} is not configured.` }, 404);

  return c.json({ ...(await checkDomain(domain)), zoneId: configured.zoneId });
});

api.post("/domains", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{ domain?: string; zoneId?: string }>();
  const domain = (body.domain ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "");

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    return c.json({ error: "Enter a bare domain, for example example.com." }, 400);
  }
  // Checked against every domain, not just this tenant's: a domain already
  // claimed by another client must be refused, and saying so is not a leak
  // because DNS is public anyway.
  if ((await listDomains(db, c.env)).some((d) => d.domain === domain)) {
    return c.json({ error: `${domain} is already configured.` }, 409);
  }

  // The zone id is what unlocks routing rules and sending onboarding. Look it
  // up rather than making the operator paste it; the field stays as an override
  // for tokens too narrow to see the zone.
  const zoneId = (body.zoneId ?? "").trim() || (await lookupZoneId(c.env, domain));
  // A platform administrator with no org selected is onboarding a new client,
  // so the domain gets a new org of its own.
  const added = await addDomain(db, domain, zoneId, scope.orgId);

  // Onboard the sending half straight away. Cloudflare writes the auth records
  // itself, so this is the difference between "add these four DNS records by
  // hand" and the checklist simply going green.
  const sending = await enableSending(c.env, added.domain, added.zoneId);

  // Whether Email Routing is already on cannot be read from the API: no
  // permission group grants GET /zones/{zone}/email/routing. Public DNS answers
  // it anyway, since Cloudflare only points the apex MX at route*.mx.cloudflare
  // once routing is enabled. Re-adding a domain that was already receiving mail
  // should not be told to go turn it on.
  const check = await checkDomain(added.domain);
  const receiving = check.records
    .filter((r) => r.service === "routing")
    .every((r) => r.status === "ok");

  audit(
    db,
    c.get("scope"),
    "domain.add",
    domain,
    added.zoneId ? "with zone" : "no zone",
    c.executionCtx,
  );
  // A newly onboarded domain changes the DNS picture; drop the cached checks.
  await c.env.SETTINGS.delete(
    `dns:status:${(await listDomains(db, c.env)).map((d) => d.domain).join(",")}`,
  );
  return c.json({ ...added, sending, receiving }, 201);
});

api.delete("/domains/:domain", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const domain = c.req.param("domain").toLowerCase();

  // 404 rather than 403 for a domain in another tenant, so the response does
  // not confirm that it exists.
  const owned = (await listDomains(db, c.env, scope.orgId || undefined)).some(
    (d) => d.domain === domain,
  );
  if (!owned) return c.json({ error: `${domain} is not configured.` }, 404);

  // Removing a domain that still has mailboxes would orphan them.
  const inUse = await db
    .select({ address: mailboxes.address })
    .from(mailboxes)
    .where(like(mailboxes.address, `%@${domain}`))
    .all();
  if (inUse.length > 0) {
    return c.json(
      { error: `${inUse.length} mailbox(es) still use ${domain}. Delete them first.` },
      409,
    );
  }

  await removeDomain(db, domain);
  audit(db, c.get("scope"), "domain.remove", domain, "", c.executionCtx);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------ api keys --- */

api.get("/api-keys", async (c) => {
  const db = drizzle(c.env.DB);
  return c.json(
    await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        preview: apiKeys.preview,
        scope: apiKeys.scope,
        restrictMailboxId: apiKeys.restrictMailboxId,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(orgFilter(c.get("scope"), apiKeys.orgId))
      .orderBy(desc(apiKeys.createdAt))
      .all(),
  );
});

api.post("/api-keys", async (c) => {
  const scope = c.get("scope");
  const org = writeOrg(scope);
  if (!org) return c.json(PICK_ORG, 400);

  const db = drizzle(c.env.DB);
  const body = await c.req.json<{
    name?: string;
    scope?: "full" | "sending";
    restrictMailboxId?: string | null;
  }>();
  if (!body.name?.trim()) return c.json({ error: "A name is required." }, 400);

  // A key restricted to a mailbox must be restricted to one this tenant owns,
  // or the restriction would hand out access across the boundary.
  if (body.restrictMailboxId && !canUseMailbox(scope, body.restrictMailboxId)) {
    return c.json({ error: "That mailbox is not available." }, 400);
  }

  const { plaintext, preview } = generateKey();
  const row = {
    id: crypto.randomUUID(),
    name: body.name.trim(),
    hash: await sha256Hex(plaintext),
    preview,
    scope: body.scope === "full" ? ("full" as const) : ("sending" as const),
    restrictMailboxId: body.restrictMailboxId || null,
    orgId: org,
    lastUsedAt: null,
    createdAt: Date.now(),
  };
  await db.insert(apiKeys).values(row);
  audit(db, scope, "apikey.create", row.name, `scope ${row.scope}`, c.executionCtx);

  const { hash, ...safe } = row;
  return c.json({ ...safe, plaintext }, 201);
});

api.delete("/api-keys/:id", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const target = and(eq(apiKeys.id, c.req.param("id")), orgFilter(scope, apiKeys.orgId));
  const key = await db.select().from(apiKeys).where(target).get();
  if (!key) return c.json({ error: "Not found." }, 404);

  await db.delete(apiKeys).where(target);
  audit(db, scope, "apikey.revoke", key.name, "", c.executionCtx);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------ webhooks --- */

api.get("/webhooks", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const own = await db
    .select()
    .from(webhooks)
    .where(orgFilter(scope, webhooks.orgId))
    .orderBy(desc(webhooks.createdAt))
    .all();

  // Deliveries carry no org of their own; they inherit it from the endpoint,
  // and a delivery log records which URLs a tenant calls.
  const ids = own.map((w) => w.id);
  const deliveries = ids.length
    ? await db
        .select()
        .from(webhookDeliveries)
        .where(inArray(webhookDeliveries.webhookId, ids))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(100)
        .all()
    : [];

  return c.json({ webhooks: own, deliveries });
});

api.post("/webhooks", async (c) => {
  const scope = c.get("scope");
  const org = writeOrg(scope);
  if (!org) return c.json(PICK_ORG, 400);

  const db = drizzle(c.env.DB);
  const body = await c.req.json<{ url?: string; eventTypes?: string[] }>();
  if (!body.url?.startsWith("https://")) {
    return c.json({ error: "The URL must be an https endpoint." }, 400);
  }
  const secretBytes = crypto.getRandomValues(new Uint8Array(24));
  const row = {
    id: crypto.randomUUID(),
    url: body.url.trim(),
    eventTypes: JSON.stringify(body.eventTypes?.length ? body.eventTypes : ["*"]),
    secret: `whsec_${[...secretBytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
    enabled: 1,
    orgId: org,
    createdAt: Date.now(),
  };
  await db.insert(webhooks).values(row);
  audit(db, scope, "webhook.create", row.url, "", c.executionCtx);
  return c.json(row, 201);
});

api.patch("/webhooks/:id", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{ enabled?: boolean; eventTypes?: string[] }>();
  const patch: Record<string, unknown> = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled ? 1 : 0;
  if (body.eventTypes) patch.eventTypes = JSON.stringify(body.eventTypes);
  if (Object.keys(patch).length === 0) return c.json({ error: "Nothing to update." }, 400);

  const target = and(eq(webhooks.id, c.req.param("id")), orgFilter(scope, webhooks.orgId));
  if (!(await db.select({ id: webhooks.id }).from(webhooks).where(target).get())) {
    return c.json({ error: "Not found." }, 404);
  }
  await db.update(webhooks).set(patch).where(target);
  return c.json({ ok: true });
});

api.delete("/webhooks/:id", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const target = and(eq(webhooks.id, c.req.param("id")), orgFilter(scope, webhooks.orgId));
  const hook = await db.select().from(webhooks).where(target).get();
  if (!hook) return c.json({ error: "Not found." }, 404);

  await db.delete(webhooks).where(target);
  audit(db, scope, "webhook.delete", hook.url, "", c.executionCtx);
  return c.json({ ok: true });
});

/* ----------------------------------------------------------- templates --- */

/**
 * A template's default sender must be a mailbox the tenant actually owns.
 * Anything else would be a template that cannot send, discovered at send time.
 */
async function senderProblem(
  db: ReturnType<typeof drizzle>,
  orgId: string,
  from: string,
): Promise<string | null> {
  if (!from) return null;
  const owned = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(eq(mailboxes.address, from.toLowerCase()), eq(mailboxes.orgId, orgId)))
    .get();
  return owned ? null : `${from} is not a mailbox on this account.`;
}

/**
 * Keep a bounded history. Unbounded it would grow with every keystroke-save on
 * a template someone is iterating on, and nobody restores the ninetieth.
 */
const VERSIONS_KEPT = 30;

/**
 * One statement, and raw rather than through the builder.
 *
 * The builder's .offset() without a .limit() emits OFFSET with no LIMIT, which
 * SQLite rejects — so this threw on every save, and because the snapshot is
 * written before the update, saving a template 500'd after recording a version
 * and before changing anything. A single DELETE also spares the round trip that
 * returns nothing in the overwhelming majority of saves.
 */
/**
 * Record what a template is, before it stops being that.
 *
 * One function and one column list, because the two writers had drifted
 * already: adding a column meant remembering both, and `name` had been missed
 * entirely, so restoring silently left it alone.
 */
/** The template, if it belongs to the caller's tenant. Null covers both. */
async function loadTemplate(
  db: ReturnType<typeof drizzle>,
  scope: Scope,
  id: string,
): Promise<typeof templates.$inferSelect | undefined> {
  return db
    .select()
    .from(templates)
    .where(and(eq(templates.id, id), orgFilter(scope, templates.orgId)))
    .get();
}

async function snapshotTemplate(
  db: ReturnType<typeof drizzle>,
  existing: typeof templates.$inferSelect,
  actorEmail: string,
  at: number,
): Promise<void> {
  await db.insert(templateVersions).values({
    id: crypto.randomUUID(),
    templateId: existing.id,
    orgId: existing.orgId,
    name: existing.name,
    subject: existing.subject,
    bodyText: existing.bodyText,
    bodyHtml: existing.bodyHtml,
    fromAddress: existing.fromAddress,
    replyTo: existing.replyTo,
    actorEmail,
    createdAt: at,
  });
  await trimVersions(db, existing.id);
}

async function trimVersions(db: ReturnType<typeof drizzle>, templateId: string): Promise<void> {
  await db.run(sql`
    delete from template_versions
    where template_id = ${templateId}
      and id not in (
        select id from template_versions
        where template_id = ${templateId}
        order by created_at desc
        limit ${VERSIONS_KEPT}
      )
  `);
}

api.get("/templates", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(templates)
    .where(orgFilter(c.get("scope"), templates.orgId))
    .orderBy(templates.name)
    .all();

  // Sanitising every row is the gallery's cost, and only the gallery's: the
  // composer's slug dropdown and the editor both discarded the field while
  // paying for it on every request.
  if (c.req.query("preview") !== "1") return c.json(rows);

  // Through the same sanitiser the send path uses, so the gallery shows what a
  // recipient gets rather than what was pasted in. Placeholders are left
  // unfilled on purpose: a template is easier to recognise by its shape and its
  // variable names than by sample data.
  return c.json(
    rows.map((t) => ({
      ...t,
      previewHtml: t.bodyHtml ? sanitiseEmailHtml(t.bodyHtml, { layout: true }) : null,
    })),
  );
});

/**
 * One template.
 *
 * Its absence is why opening the editor fetched every template and picked one
 * out, paying for a sanitiser pass over all of them to display none of it.
 */
api.get("/templates/:id", async (c) => {
  const found = await loadTemplate(drizzle(c.env.DB), c.get("scope"), c.req.param("id"));
  return found ? c.json(found) : c.json({ error: "Not found." }, 404);
});

api.post("/templates", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{
    slug?: string;
    name?: string;
    subject?: string;
    bodyText?: string;
    bodyHtml?: string;
    fromAddress?: string;
    replyTo?: string;
  }>();

  const org = writeOrg(scope);
  if (!org) return c.json(PICK_ORG, 400);
  const slug = (body.slug ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return c.json({ error: "The slug may contain lowercase letters, numbers and hyphens." }, 400);
  }
  // Within this org only: another tenant's 'welcome' is not a collision, and
  // reporting it as one would disclose that they have it.
  const clash = await db
    .select({ id: templates.id })
    .from(templates)
    .where(and(eq(templates.slug, slug), eq(templates.orgId, org)))
    .get();
  if (clash) return c.json({ error: `A template called '${slug}' already exists.` }, 409);

  const fromAddress = (str(body.fromAddress, "fromAddress") ?? "").toLowerCase();
  const senderIssue = await senderProblem(db, org, fromAddress);
  if (senderIssue) return c.json({ error: senderIssue }, 400);

  const replyTo = str(body.replyTo, "replyTo") ?? "";
  const replyIssue = replyToProblem(replyTo);
  if (replyIssue) return c.json({ error: replyIssue }, 400);

  const now = Date.now();
  const row = {
    id: crypto.randomUUID(),
    slug,
    name: body.name?.trim() || slug,
    subject: body.subject ?? "",
    bodyText: body.bodyText ?? "",
    bodyHtml: body.bodyHtml || null,
    fromAddress,
    replyTo,
    orgId: org,
    updatedAt: now,
    createdAt: now,
  };
  await db.insert(templates).values(row);
  return c.json(row, 201);
});

api.patch("/templates/:id", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{
    name?: string;
    subject?: string;
    bodyText?: string;
    bodyHtml?: string;
    fromAddress?: string;
    replyTo?: string;
  }>();
  const target = and(eq(templates.id, c.req.param("id")), orgFilter(scope, templates.orgId));
  const existing = await loadTemplate(db, scope, c.req.param("id"));
  if (!existing) return c.json({ error: "Not found." }, 404);

  const patchFrom = str(body.fromAddress, "fromAddress")?.toLowerCase();
  if (patchFrom !== undefined) {
    const issue = await senderProblem(db, existing.orgId, patchFrom);
    if (issue) return c.json({ error: issue }, 400);
  }
  const patchReplyTo = str(body.replyTo, "replyTo");
  if (patchReplyTo !== undefined) {
    const issue = replyToProblem(patchReplyTo);
    if (issue) return c.json({ error: issue }, 400);
  }

  // A template is production copy other systems send by slug, so an accidental
  // save is a live incident and "undo" has to survive a page reload.
  await snapshotTemplate(db, existing, scope.email, Date.now());

  await db
    .update(templates)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.subject !== undefined ? { subject: body.subject } : {}),
      ...(body.bodyText !== undefined ? { bodyText: body.bodyText } : {}),
      ...(body.bodyHtml !== undefined ? { bodyHtml: body.bodyHtml || null } : {}),
      ...(patchFrom !== undefined ? { fromAddress: patchFrom } : {}),
      ...(patchReplyTo !== undefined ? { replyTo: patchReplyTo } : {}),
      updatedAt: Date.now(),
    })
    .where(target);
  return c.json(await db.select().from(templates).where(target).get());
});

/**
 * Copy a template within its own tenant.
 *
 * Server-side because the tenant is a property of the source row, not something
 * a client should assert, and because picking a free slug next to the unique
 * index that enforces it beats fetching every slug over the wire and racing.
 */
api.post("/templates/:id/duplicate", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const source = await loadTemplate(db, scope, c.req.param("id"));
  if (!source) return c.json({ error: "Not found." }, 404);

  const taken = new Set(
    (
      await db
        .select({ slug: templates.slug })
        .from(templates)
        .where(eq(templates.orgId, source.orgId))
        .all()
    ).map((t) => t.slug),
  );
  let slug = `${source.slug}-copy`;
  for (let n = 2; taken.has(slug); n++) slug = `${source.slug}-copy-${n}`;

  // The read above cannot be atomic with the write, so two duplicates racing
  // compute the same suffix and one loses on the unique index. Retry rather
  // than surface a constraint error.
  const now = Date.now();
  for (let attempt = 0; ; attempt++) {
    const row = {
      ...source,
      id: crypto.randomUUID(),
      slug,
      name: `${source.name} copy`,
      updatedAt: now,
      createdAt: now,
    };
    try {
      await db.insert(templates).values(row);
      return c.json(row, 201);
    } catch (err) {
      // Retry only when the slug is now genuinely taken — asking the database
      // rather than pattern-matching an error string, which differs between
      // drivers and would either swallow real failures or miss this one.
      const clash = await db
        .select({ id: templates.id })
        .from(templates)
        .where(and(eq(templates.slug, slug), eq(templates.orgId, source.orgId)))
        .get();
      if (!clash || attempt >= 5) throw err;
      taken.add(slug);
      for (let n = 2; taken.has(slug); n++) slug = `${source.slug}-copy-${n}`;
    }
  }
});

/** Previous states, newest first. */
api.get("/templates/:id/versions", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const owner = await loadTemplate(db, scope, c.req.param("id"));
  if (!owner) return c.json({ error: "Not found." }, 404);

  return c.json(
    await db
      .select()
      .from(templateVersions)
      .where(eq(templateVersions.templateId, owner.id))
      .orderBy(desc(templateVersions.createdAt))
      .all(),
  );
});

/** Restore is itself an edit, so the state being replaced is kept too. */
api.post("/templates/:id/versions/:versionId/restore", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const target = and(eq(templates.id, c.req.param("id")), orgFilter(scope, templates.orgId));
  const existing = await loadTemplate(db, scope, c.req.param("id"));
  if (!existing) return c.json({ error: "Not found." }, 404);

  const version = await db
    .select()
    .from(templateVersions)
    .where(
      and(
        eq(templateVersions.id, c.req.param("versionId")),
        eq(templateVersions.templateId, existing.id),
      ),
    )
    .get();
  if (!version) return c.json({ error: "That version no longer exists." }, 404);

  // Re-checked, not trusted: the mailbox a version named may have been deleted
  // since, and validating on write exists precisely so a template cannot be
  // left in a state that only fails when someone finally sends it.
  const staleSender = await senderProblem(db, existing.orgId, version.fromAddress);
  const staleReply = replyToProblem(version.replyTo);

  const now = Date.now();
  await snapshotTemplate(db, existing, scope.email, now);

  await db
    .update(templates)
    .set({
      name: version.name,
      subject: version.subject,
      bodyText: version.bodyText,
      bodyHtml: version.bodyHtml,
      // Dropped rather than restored when no longer valid, so the restore
      // succeeds and the field is visibly empty instead of quietly broken.
      fromAddress: staleSender ? "" : version.fromAddress,
      replyTo: staleReply ? "" : version.replyTo,
      updatedAt: now,
    })
    .where(target);

  return c.json({
    ...(await db.select().from(templates).where(target).get()),
    ...(staleSender ? { warning: staleSender } : {}),
  });
});

api.delete("/templates/:id", async (c) => {
  const db = drizzle(c.env.DB);
  await db
    .delete(templates)
    .where(and(eq(templates.id, c.req.param("id")), orgFilter(c.get("scope"), templates.orgId)));
  return c.json({ ok: true });
});

/* ------------------------------------------------------------ contacts --- */

api.get("/contacts", async (c) => {
  const db = drizzle(c.env.DB);
  const q = c.req.query("q");
  return c.json(
    await db
      .select()
      .from(contacts)
      .where(
        and(
          orgFilter(c.get("scope"), contacts.orgId),
          q
            ? or(
                like(contacts.email, `%${q}%`),
                like(contacts.name, `%${q}%`),
                like(contacts.company, `%${q}%`),
              )
            : undefined,
        ),
      )
      .orderBy(desc(contacts.createdAt))
      .limit(500)
      .all(),
  );
});

api.post("/contacts", async (c) => {
  const scope = c.get("scope");
  const org = writeOrg(scope);
  if (!org) return c.json(PICK_ORG, 400);

  const db = drizzle(c.env.DB);
  const body = await c.req.json<{
    email?: string;
    name?: string;
    company?: string;
    notes?: string;
  }>();
  const email = (body.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "A valid email address is required." }, 400);
  }
  // Within this org: the same person may be a contact of several tenants.
  const clash = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.email, email), eq(contacts.orgId, org)))
    .get();
  if (clash) return c.json({ error: `${email} is already a contact.` }, 409);

  const row = {
    id: crypto.randomUUID(),
    email,
    name: body.name?.trim() ?? "",
    company: body.company?.trim() ?? "",
    notes: body.notes?.trim() ?? "",
    orgId: org,
    createdAt: Date.now(),
  };
  await db.insert(contacts).values(row);
  return c.json(row, 201);
});

api.delete("/contacts/:id", async (c) => {
  const db = drizzle(c.env.DB);
  await db
    .delete(contacts)
    .where(and(eq(contacts.id, c.req.param("id")), orgFilter(c.get("scope"), contacts.orgId)));
  return c.json({ ok: true });
});

/* -------------------------------------------------------- suppressions --- */

api.get("/suppressions", async (c) => {
  const db = drizzle(c.env.DB);
  return c.json(
    await db
      .select()
      .from(suppressions)
      .where(orgFilter(c.get("scope"), suppressions.orgId))
      .orderBy(desc(suppressions.createdAt))
      .all(),
  );
});

api.post("/suppressions", async (c) => {
  const scope = c.get("scope");
  const org = writeOrg(scope);
  if (!org) return c.json(PICK_ORG, 400);

  const db = drizzle(c.env.DB);
  const body = await c.req.json<{ email?: string; reason?: string; detail?: string }>();
  const email = (body.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "A valid email address is required." }, 400);
  }
  const reason: "bounce" | "complaint" | "manual" =
    body.reason === "bounce" || body.reason === "complaint" ? body.reason : "manual";
  await suppress(db, org, [email], reason, body.detail?.trim() ?? "");
  audit(db, scope, "suppression.add", email, reason, c.executionCtx);
  return c.json({ email, reason }, 201);
});

api.delete("/suppressions/:id", async (c) => {
  const scope = c.get("scope");
  const db = drizzle(c.env.DB);
  const target = and(eq(suppressions.id, c.req.param("id")), orgFilter(scope, suppressions.orgId));
  const row = await db.select().from(suppressions).where(target).get();
  if (!row) return c.json({ error: "Not found." }, 404);

  await db.delete(suppressions).where(target);
  audit(db, scope, "suppression.remove", row.email, "", c.executionCtx);
  return c.json({ ok: true });
});

export default api;
