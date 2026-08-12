/**
 * The public demo, and the two things that make it safe to leave on the
 * internet.
 *
 * demo.mittova.com runs the ordinary Worker against throwaway resources and
 * wipes itself back to a known state every hour. Two properties have to hold,
 * and both are deliberately enforced twice, in independent ways, because either
 * one failing alone is an incident:
 *
 * **It never sends mail.** `sendEmail` refuses when DEMO_MODE is set, and the
 * demo's `wrangler.jsonc` omits the `send_email` binding entirely, so even with
 * the flag wrong there is no `env.EMAIL` to call. Code and configuration have to
 * fail together for a message to leave.
 *
 * **The reset can never fire on a real deployment.** It is gated here on
 * DEMO_MODE and again by the caller in `src/index.ts`, and the flag is matched
 * against one exact literal so that a typo, a stale value, or an inherited empty
 * string all mean *off*. That is the safe direction: a demo with the flag
 * missing merely goes stale, while a production deployment with the flag
 * wrongly on would lose every row on the hour.
 */

import seedSql from "./demo-seed.sql";
import { splitStatements } from "./sql";
import { BACKUP_PREFIX } from "./storage";

/**
 * The demo's own schedule. The Worker's `scheduled` handler tells its jobs apart
 * by comparing `event.cron`, so this is matched exactly rather than being the
 * "any other cron" branch.
 */
export const DEMO_RESET_CRON = "0 * * * *";

/**
 * Exactly one value means yes.
 *
 * Not `Boolean(env.DEMO_MODE)`, and not a list of friendly spellings: an
 * unrecognised value must read as off, and a var that is present-but-empty on
 * every normal deployment must never read as on.
 */
export function isDemo(env: Env): boolean {
  return env.DEMO_MODE === "1";
}

/** Thrown rather than returned: reaching this at all means something is wrong. */
export class DemoModeError extends Error {}

/**
 * A plausible raw source for a seeded message.
 *
 * The demo's "view raw source" reads an R2 object at the row's `raw_key`, so
 * without this every seeded message offers a link that 404s — one of the first
 * things a visitor clicks. Synthesised from the row rather than stored as nine
 * more blobs, so the headers can never drift away from what the dashboard shows
 * beside them.
 */
function rawSource(row: DemoMessageRow): string {
  const from = row.from_name ? `${row.from_name} <${row.from_addr}>` : row.from_addr;
  const auth = [
    row.spf && `spf=${row.spf}`,
    row.dkim && `dkim=${row.dkim}`,
    row.dmarc && `dmarc=${row.dmarc}`,
  ]
    .filter(Boolean)
    .join("; ");

  // A header with nothing to say is dropped rather than emitted empty, which is
  // what a real MTA would do: no Message-ID line at all beats "Message-ID:".
  const headers = [
    `Return-Path: <${row.from_addr}>`,
    `Delivered-To: ${row.to_addr}`,
    auth ? `Authentication-Results: mittova.demo; ${auth}` : null,
    `From: ${from}`,
    `To: ${row.to_addr}`,
    `Subject: ${row.subject}`,
    `Date: ${new Date(row.created_at).toUTCString()}`,
    row.rfc_message_id ? `Message-ID: ${row.rfc_message_id}` : null,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
  ].filter((line): line is string => line !== null);

  // One blank line separates the headers from the body, per RFC 5322.
  return `${headers.join("\r\n")}\r\n\r\n${row.body_text ?? ""}\r\n`;
}

interface DemoMessageRow {
  raw_key: string;
  from_addr: string;
  from_name: string | null;
  to_addr: string;
  subject: string;
  rfc_message_id: string | null;
  body_text: string | null;
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  created_at: number;
}

/**
 * Wipe the demo back to its seeded state.
 *
 * The whole seed runs as one `batch`, which D1 wraps in a transaction, so a
 * reset either lands completely or not at all — a half-applied wipe would leave
 * the demo emptier than it started.
 */
export async function resetDemoData(
  env: Env,
): Promise<{ statements: number; rawObjects: number; backupsSwept: number }> {
  // The inner half of the two-stop guard. The caller checks too; this is here so
  // that a future caller which forgets cannot delete a production database.
  if (!isDemo(env)) {
    throw new DemoModeError("refusing to reset: DEMO_MODE is not set to 1");
  }

  const statements = splitStatements(seedSql);
  await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));

  /**
   * Sweep anything a visitor left in R2 outside the message layout.
   *
   * The seed's DELETE block covers every table, which made it easy to believe
   * the reset was total — it was not. `POST /api/backups` writes an NDJSON dump
   * under `_backups/`, no route deletes one, and wiping tables does not touch
   * R2, so backups accumulated across every reset. That route now refuses on the
   * demo; this is the second stop, so the invariant holds even if the first is
   * removed.
   *
   * Safe to sweep by prefix because the demo has a bucket of its own — the same
   * separation D1 and KV already have. Nothing else writes here, so `_backups/`
   * in this bucket can only be the demo's own.
   *
   * Paginated: R2 returns at most 1000 keys per call, and a truncated first page
   * quietly leaving objects behind is the same bug this sweep exists to fix.
   */
  let swept = 0;
  let cursor: string | undefined;
  do {
    const page = await env.STORAGE.list({ prefix: BACKUP_PREFIX, cursor });
    for (const object of page.objects) {
      await env.STORAGE.delete(object.key);
      swept++;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const { results } = await env.DB.prepare(
    `SELECT raw_key, from_addr, from_name, to_addr, subject, rfc_message_id,
            body_text, spf, dkim, dmarc, created_at
       FROM messages
      WHERE raw_key IS NOT NULL`,
  ).all<DemoMessageRow>();

  for (const row of results) {
    await env.STORAGE.put(row.raw_key, rawSource(row), {
      httpMetadata: { contentType: "message/rfc822" },
    });
  }

  return {
    statements: statements.length,
    rawObjects: results.length,
    backupsSwept: swept,
  };
}
