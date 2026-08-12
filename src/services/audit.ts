import type { Db } from "../db/types";
import { auditLog } from "../db/schema";
import type { Scope } from "../auth";

/**
 * Everything worth an audit entry. A union rather than a bare string so adding
 * a privileged action forces a decision about logging it, and so the UI's tone
 * map cannot drift out of sync.
 */
export type AuditAction =
  | "mailbox.create"
  | "mailbox.update"
  | "mailbox.delete"
  | "user.create"
  | "user.update"
  | "user.mailboxes"
  | "user.delete"
  | "user.invite"
  | "apikey.create"
  | "apikey.revoke"
  | "webhook.create"
  | "webhook.delete"
  | "suppression.add"
  | "suppression.remove"
  | "message.delete"
  | "domain.add"
  | "domain.remove"
  | "org.create"
  | "org.rename"
  | "org.delete"
  | "org.export"
  | "backup.run";

/**
 * Record a privileged action.
 *
 * Only actions that change access or destroy data are logged — reads are not,
 * since an audit trail nobody reads is worse than none, and mailbox reads are
 * already covered by per-user read state.
 *
 * Deliberately best-effort: a failure to write the trail must never fail the
 * action the operator asked for.
 */
export function audit(
  db: Db,
  scope: Scope,
  action: AuditAction,
  target = "",
  detail = "",
  /** Defer the write off the response path; the caller never reads the result. */
  ctx?: { waitUntil(p: Promise<unknown>): void },
): void {
  const write = writeEntry(db, scope, action, target, detail);
  if (ctx) ctx.waitUntil(write);
  else void write;
}

async function writeEntry(
  db: Db,
  scope: Scope,
  action: AuditAction,
  target: string,
  detail: string,
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      id: crypto.randomUUID(),
      actorId: scope.userId,
      actorEmail: scope.isRootAdmin ? `${scope.email} (admin password)` : scope.email,
      action,
      target,
      detail,
      orgId: scope.orgId,
      createdAt: Date.now(),
    });
  } catch (err) {
    console.error("audit write failed", action, target, err);
  }
}
