import { applyD1Migrations, env } from "cloudflare:test";
import { deleteByPrefix } from "../src/services/storage";
import { beforeAll, beforeEach } from "vitest";

/**
 * Build the schema from the same baseline a real deployment applies.
 *
 * The migrations are read on the node side in vitest.config.ts and handed over
 * as a binding, because workerd has no host filesystem. Using the real
 * migrations directory rather than a fixture is deliberate: the baseline is
 * generated from the running database and carries the FTS5 virtual table and
 * its triggers, which drizzle-kit cannot model, so a broken baseline should
 * fail here rather than on a fresh install.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

/** Everything the baseline creates, so each test starts from nothing. */
const TABLES = [
  "template_versions",
  "templates",
  "webhook_deliveries",
  "webhooks",
  "api_keys",
  "events",
  "attachments",
  "message_reads",
  "drafts",
  "messages",
  "user_mailboxes",
  "users",
  "mailboxes",
  "domains",
  "organizations",
  "contacts",
  "suppressions",
  "audit_log",
];

beforeEach(async () => {
  // Truncate rather than rebuild: recreating the FTS5 table and its triggers
  // per test is slow, and the triggers keep the index in step with the deletes.
  for (const t of TABLES) await env.DB.prepare(`delete from ${t}`).run();

  // KV holds sessions and the DNS cache; a session leaking between tests would
  // make an isolation test pass for the wrong reason.
  const keys = await env.SETTINGS.list();
  for (const k of keys.keys) await env.SETTINGS.delete(k.name);

  // R2 holds raw MIME, attachments and backups. Left in place it makes any test
  // that counts objects depend on what ran before it — a backup written by one
  // test was still there for the next, which is an order-dependent pass waiting
  // to become a confusing failure. The helper is the demo reset's, so pagination
  // and batching are defined once rather than in two loops that can drift.
  await deleteByPrefix(env.STORAGE);
});
