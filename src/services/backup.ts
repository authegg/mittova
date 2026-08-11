import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import { BACKUP_PREFIX, backupKey } from "./storage";

/**
 * Nightly backup, driven by the Worker's cron trigger.
 *
 * Exports every D1 table as newline-delimited JSON into R2 under
 * `backups/<date>/`. NDJSON rather than SQL so a restore can be replayed with
 * ordinary inserts and a partial file is still readable up to the last
 * complete line.
 *
 * Raw MIME and attachments already live in R2 and are not copied — duplicating
 * them would double storage for no extra safety. Set an R2 lifecycle rule if
 * you want versioned object retention.
 *
 * SECURITY: a backup contains password hashes, API key hashes and webhook
 * signing secrets in the clear. It has to, or a restore would lock everyone out
 * and silently break every integration. Treat the file as a credential: keep
 * the bucket private, and do not copy backups anywhere you would not put the
 * database itself.
 */

/** Order matters on restore: parents before the rows that reference them. */
const TABLES = [
  // Tenants first: every row below belongs to one, and a restore that rebuilt
  // the mail without the organizations and domains would come back with no
  // tenants at all — which is what this list used to do.
  "organizations",
  "domains",
  "mailboxes",
  "users",
  "user_mailboxes",
  "messages",
  "attachments",
  "events",
  "message_reads",
  "drafts",
  "api_keys",
  "webhooks",
  "templates",
  "template_versions",
  "webhook_deliveries",
  "contacts",
  "suppressions",
  "audit_log",
] as const;

/** How long backups are kept before pruning. */
export const RETENTION_DAYS = 30;

export interface BackupResult {
  key: string;
  bytes: number;
  durationMs: number;
  pruned: number;
}

export async function runBackup(env: Env, at = new Date()): Promise<BackupResult> {
  const started = Date.now();
  const db = drizzle(env.DB);
  const iso = at.toISOString();
  const key = backupKey(at);

  // The table order travels with the backup so a restore never has to keep its
  // own copy of the schema's dependency ordering.
  const lines: string[] = [
    JSON.stringify({ _meta: "mittova-backup", version: 1, takenAt: iso, tables: TABLES }),
  ];

  for (const table of TABLES) {
    try {
      // Table names cannot be bound as parameters; TABLES is a fixed allowlist,
      // never user input.
      const rows = (await db.all(sql.raw(`SELECT * FROM ${table}`))) as Record<string, unknown>[];
      for (const row of rows) lines.push(JSON.stringify({ _table: table, ...row }));
    } catch {
      // A table added by a later migration may not exist on older deployments.
    }
  }

  // Encode once: the string, a second copy from join, and a third from a
  // separate encode for the byte count is three copies of the whole corpus.
  const bytes = new TextEncoder().encode(lines.join("\n"));
  await env.STORAGE.put(key, bytes, {
    httpMetadata: { contentType: "application/x-ndjson" },
    customMetadata: { takenAt: iso },
  });

  // Prune here rather than only in the cron handler, so both entry points
  // behave the same way.
  const pruned = await pruneBackups(env);

  return { key, bytes: bytes.byteLength, durationMs: Date.now() - started, pruned };
}

/** Most recent backups first. */
export async function listBackups(
  env: Env,
  limit = 20,
): Promise<{ key: string; size: number; uploaded: string }[]> {
  const listed = await env.STORAGE.list({ prefix: BACKUP_PREFIX, limit: Math.max(limit, 100) });
  return listed.objects
    .map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString() }))
    .sort((a, b) => b.uploaded.localeCompare(a.uploaded))
    .slice(0, limit);
}

/** Drop backups beyond the retention window so R2 does not grow without bound. */
export async function pruneBackups(env: Env, keepDays = RETENTION_DAYS): Promise<number> {
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const listed = await env.STORAGE.list({ prefix: BACKUP_PREFIX, limit: 1000 });
  const stale = listed.objects.filter((o) => o.uploaded.getTime() < cutoff);
  await Promise.all(stale.map((o) => env.STORAGE.delete(o.key)));
  return stale.length;
}

/**
 * Everything belonging to one tenant, as NDJSON.
 *
 * The nightly backup is the whole database, which means restoring one client
 * means restoring every client — and handing a client their own data would mean
 * handing them everyone's. This is scoped, so it can be given to the client it
 * belongs to, or used to move one tenant somewhere else.
 *
 * Every table is reached from the org explicitly rather than by a generic
 * `org_id` filter, because half of them do not carry one: a message belongs to
 * a tenant through its mailbox, an attachment through its message. Writing the
 * path out is what makes it checkable.
 */
const TENANT_QUERIES: [string, string][] = [
  ["organizations", "select * from organizations where id = ?"],
  ["domains", "select * from domains where org_id = ?"],
  ["mailboxes", "select * from mailboxes where org_id = ?"],
  ["users", "select * from users where org_id = ?"],
  [
    "user_mailboxes",
    "select * from user_mailboxes where user_id in (select id from users where org_id = ?)",
  ],
  [
    "messages",
    "select * from messages where mailbox_id in (select id from mailboxes where org_id = ?)",
  ],
  [
    "attachments",
    "select * from attachments where message_id in (select m.id from messages m join mailboxes b on b.id = m.mailbox_id where b.org_id = ?)",
  ],
  [
    "events",
    "select * from events where message_id in (select m.id from messages m join mailboxes b on b.id = m.mailbox_id where b.org_id = ?)",
  ],
  [
    "message_reads",
    "select * from message_reads where message_id in (select m.id from messages m join mailboxes b on b.id = m.mailbox_id where b.org_id = ?)",
  ],
  [
    "drafts",
    "select * from drafts where mailbox_id in (select id from mailboxes where org_id = ?)",
  ],
  ["api_keys", "select * from api_keys where org_id = ?"],
  ["webhooks", "select * from webhooks where org_id = ?"],
  [
    "webhook_deliveries",
    "select * from webhook_deliveries where webhook_id in (select id from webhooks where org_id = ?)",
  ],
  ["templates", "select * from templates where org_id = ?"],
  ["template_versions", "select * from template_versions where org_id = ?"],
  ["contacts", "select * from contacts where org_id = ?"],
  ["suppressions", "select * from suppressions where org_id = ?"],
  ["audit_log", "select * from audit_log where org_id = ?"],
];

/**
 * Secrets that must not travel with an export.
 *
 * A whole-database backup keeps them because a restore that dropped them would
 * lock everyone out. An export is a copy leaving the deployment, so the
 * password hashes, key hashes and signing secrets are redacted: the recipient
 * needs their mail and their configuration, not the means to authenticate as
 * anyone.
 */
const REDACT: Record<string, string[]> = {
  users: ["password_hash", "password_salt", "invite_hash"],
  api_keys: ["hash"],
  webhooks: ["secret"],
};

export async function exportOrg(env: Env, orgId: string): Promise<string> {
  const lines: string[] = [
    JSON.stringify({
      _meta: "mittova-org-export",
      version: 1,
      orgId,
      takenAt: new Date().toISOString(),
      redacted: REDACT,
    }),
  ];

  for (const [table, query] of TENANT_QUERIES) {
    // Bound, not interpolated. The org id arrives from a validated route param,
    // but building SQL by substituting a string into it is a habit that only
    // has to be wrong once, and D1 binds parameters perfectly well here.
    const result = await env.DB.prepare(query).bind(orgId).all<Record<string, unknown>>();
    const rows = result.results;
    const drop = REDACT[table] ?? [];
    for (const row of rows) {
      for (const field of drop) if (field in row) row[field] = null;
      lines.push(JSON.stringify({ _table: table, ...row }));
    }
  }

  return lines.join("\n");
}
