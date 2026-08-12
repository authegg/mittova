import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { users, userMailboxes, mailboxes, organizations } from "./db/schema";
import { verifyPassword } from "./services/password";

const COOKIE = "mv_session";
const TTL_SECONDS = 60 * 60 * 24 * 7;

/**
 * Who is making this request and what they may touch.
 *
 * `mailboxIds: "all"` means no filtering, and is reachable only by a platform
 * administrator who has not selected an org. Everyone else — including an org
 * owner — gets an explicit allow-list already narrowed to their org, so the one
 * filter that message, draft and attachment queries already apply is also what
 * enforces the tenant boundary. An empty list must deny everything rather than
 * mean "no filter", which is the classic way a permission check inverts itself.
 */
export interface Scope {
  userId: string | null;
  email: string;
  name: string;
  role: "owner" | "member";
  mailboxIds: "all" | string[];
  /** True for the break-glass ADMIN_PASSWORD login, which has no user row. */
  isRootAdmin: boolean;
  /**
   * Tenant the request acts in. Empty only for a platform administrator who has
   * not picked one; every query over org-owned data filters on it.
   */
  orgId: string;
  /** May act in any org, and may create and delete orgs. */
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
  /** Email-safe HTML appended when composing; empty for the admin login. */
  signature: string;
}

/**
 * Declared globally so every Context shares one Variables shape. Without this,
 * a route typed with Variables and a helper typed without them are mutually
 * unassignable, because Hono's `set` makes the generic invariant.
 */
declare module "hono" {
  interface ContextVariableMap {
    scope: Scope;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const ROOT_SCOPE = (email: string): Scope => ({
  userId: null,
  email,
  name: "Administrator",
  role: "owner",
  mailboxIds: "all",
  isRootAdmin: true,
  orgId: "",
  isPlatformAdmin: true,
  mustChangePassword: false,
  signature: "",
});

/** Header the dashboard sends to say which tenant it is looking at. */
const ORG_HEADER = "x-mittova-org";

/** Mailboxes belonging to one org, which is what an org's people may touch. */
async function orgMailboxIds(db: DrizzleD1Database, orgId: string): Promise<string[]> {
  const rows = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(eq(mailboxes.orgId, orgId))
    .all();
  return rows.map((r) => r.id);
}

/**
 * Which org a platform administrator is currently acting in.
 *
 * Only consulted for platform administrators: for everyone else the org comes
 * from their user row and the header is ignored, so a member cannot reach
 * another tenant's data by setting it.
 */
async function selectedOrg(c: Context<{ Bindings: Env }>, db: DrizzleD1Database): Promise<string> {
  const requested = c.req.header(ORG_HEADER)?.trim();
  if (!requested) return "";

  const org = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, requested))
    .get();
  return org?.id ?? "";
}

/**
 * Exported so accepting an invite can sign the person in directly. Making them
 * type the password they just chose, into a form they were just on, is a step
 * that exists only because the code was not arranged for it.
 */
export async function startSession(
  c: Context<{ Bindings: Env }>,
  userId: string | null,
): Promise<void> {
  const token = crypto.randomUUID();
  await c.env.SETTINGS.put(`session:${token}`, JSON.stringify({ userId, createdAt: Date.now() }), {
    expirationTtl: TTL_SECONDS,
  });
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: TTL_SECONDS,
  });
}

/**
 * Sign in. An email identifies a user row; omitting it falls back to the
 * ADMIN_PASSWORD break-glass owner so the dashboard can never be locked out
 * even if every user row is deleted.
 */
export async function login(
  c: Context<{ Bindings: Env }>,
  email: string | undefined,
  password: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const db = drizzle(c.env.DB);
  const normalised = email?.trim().toLowerCase();

  if (normalised) {
    const user = await db.select().from(users).where(eq(users.email, normalised)).get();
    // Verify against a dummy record when the user is missing so a bad address
    // and a bad password take the same time and return the same message.
    if (!user) {
      await verifyPassword(password, {
        passwordHash: "0".repeat(64),
        passwordSalt: "00".repeat(16),
        passwordIterations: 200_000,
      });
      return { ok: false, reason: "Incorrect email or password." };
    }
    if (!(await verifyPassword(password, user))) {
      return { ok: false, reason: "Incorrect email or password." };
    }
    if (user.disabled) return { ok: false, reason: "This account is disabled." };

    await db.update(users).set({ lastLoginAt: Date.now() }).where(eq(users.id, user.id));
    await startSession(c, user.id);
    return { ok: true };
  }

  const expected = c.env.ADMIN_PASSWORD;
  if (!expected) return { ok: false, reason: "No administrator password is configured." };
  if (!timingSafeEqual(password, expected)) {
    return { ok: false, reason: "Incorrect email or password." };
  }
  await startSession(c, null);
  return { ok: true };
}

export async function logout(c: Context<{ Bindings: Env }>): Promise<void> {
  const token = getCookie(c, COOKIE);
  if (token) await c.env.SETTINGS.delete(`session:${token}`);
  deleteCookie(c, COOKIE, { path: "/" });
}

/** Resolve the caller's scope, or null when unauthenticated. */
export async function resolveScope(c: Context<{ Bindings: Env }>): Promise<Scope | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;

  const raw = await c.env.SETTINGS.get(`session:${token}`);
  if (!raw) return null;

  let userId: string | null = null;
  try {
    userId = (JSON.parse(raw) as { userId: string | null }).userId ?? null;
  } catch {
    return null;
  }

  const db = drizzle(c.env.DB);

  // The break-glass admin is a platform administrator and must be able to act
  // inside a tenant, not just read across all of them. Returning before the
  // header is read left it able to see everything and create nothing.
  if (userId === null) {
    const root = ROOT_SCOPE(c.env.ADMIN_EMAIL ?? "admin");
    const acting = await selectedOrg(c, db);
    if (!acting) return root;
    return { ...root, orgId: acting, mailboxIds: await orgMailboxIds(db, acting) };
  }

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  // Deleted or disabled mid-session: drop the session rather than serve it.
  if (!user || user.disabled) {
    await c.env.SETTINGS.delete(`session:${token}`);
    return null;
  }

  const base = {
    userId: user.id,
    email: user.email,
    name: user.name,
    isRootAdmin: false,
    mustChangePassword: Boolean(user.mustChangePassword),
    signature: user.signature,
  };

  // A user row with no org is a platform administrator: they may act in any
  // tenant, and see across all of them until they pick one.
  if (user.orgId === "") {
    const acting = await selectedOrg(c, db);
    return {
      ...base,
      role: "owner",
      orgId: acting,
      isPlatformAdmin: true,
      mailboxIds: acting ? await orgMailboxIds(db, acting) : "all",
    };
  }

  if (user.role === "owner") {
    return {
      ...base,
      role: "owner",
      orgId: user.orgId,
      isPlatformAdmin: false,
      // An org owner sees everything in their own org and nothing outside it.
      mailboxIds: await orgMailboxIds(db, user.orgId),
    };
  }

  const assigned = await db
    .select({ mailboxId: userMailboxes.mailboxId })
    .from(userMailboxes)
    .where(eq(userMailboxes.userId, user.id))
    .all();

  // Intersected with the org's mailboxes rather than trusted outright, so an
  // assignment left behind by a mailbox that changed hands cannot survive as a
  // hole in the tenant boundary.
  const withinOrg = new Set(await orgMailboxIds(db, user.orgId));

  return {
    ...base,
    role: "member",
    orgId: user.orgId,
    isPlatformAdmin: false,
    mailboxIds: assigned.map((a) => a.mailboxId).filter((id) => withinOrg.has(id)),
  };
}

export const requireAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const scope = await resolveScope(c);
  if (!scope) return c.json({ error: "unauthorized" }, 401);
  c.set("scope", scope);
  await next();
};

/** Account-level administration: users, keys, webhooks, domain, billing-ish. */
export const requireOwner: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const scope = await resolveScope(c);
  if (!scope) return c.json({ error: "unauthorized" }, 401);
  if (scope.role !== "owner") {
    return c.json({ error: "This action requires an owner account." }, 403);
  }
  c.set("scope", scope);
  await next();
};

/**
 * Platform-level administration: anything that crosses the tenant boundary.
 *
 * Distinct from requireOwner, which is satisfied by the owner of any one org. A
 * database backup spans every tenant, so an org owner must not be able to take
 * one.
 */
export const requirePlatformAdmin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const scope = await resolveScope(c);
  if (!scope) return c.json({ error: "unauthorized" }, 401);
  if (!scope.isPlatformAdmin) {
    return c.json({ error: "This action requires a platform administrator." }, 403);
  }
  c.set("scope", scope);
  await next();
};

/** True when the caller may read and send as this mailbox. */
export function canUseMailbox(scope: Scope, mailboxId: string): boolean {
  return scope.mailboxIds === "all" || scope.mailboxIds.includes(mailboxId);
}
