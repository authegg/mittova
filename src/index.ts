import { Hono } from "hono";
import api from "./api/routes";
import v1 from "./api/public";
import { ingestEmail } from "./email/ingest";
import { drizzle } from "drizzle-orm/d1";
import { pruneBackups, runBackup } from "./services/backup";
import { alertBody, runHealthCheck, type HealthReport } from "./services/health";
import { mailboxes } from "./db/schema";
import { sendEmail } from "./services/send";
import type { Db } from "./db/types";

/**
 * Mail the alert, from the first mailbox that can send.
 *
 * Deliberately the ordinary send path: an alert that used a private shortcut
 * would keep arriving while real sending was broken, which is the one time it
 * most needs to be believed.
 */
async function sendHealthAlert(db: Db, env: Env, report: HealthReport): Promise<void> {
  const to = env.ALERT_EMAIL?.trim();
  if (!to) return; // A deployment that has not asked for alerts gets none.

  const from = await db.select().from(mailboxes).limit(1).get();
  if (!from) return;

  const { subject, text } = alertBody(report);
  await sendEmail(db, env, { orgId: from.orgId, mailboxId: from.id, to: [to], subject, text });
}

const app = new Hono<{ Bindings: Env }>();

/**
 * Liveness for an external probe.
 *
 * Unauthenticated and deliberately cheap, but it does touch D1 rather than
 * answering a constant: the point is to fail when the database is unreachable,
 * which a static 200 would not. It reports nothing about the data, so there is
 * nothing here worth authenticating.
 *
 * This is the half the scheduled check cannot do. A route throwing leaves no
 * trace in the database, so catching that needs something outside the Worker
 * asking whether it is still answering.
 */
app.get("/api/health", async (c) => {
  try {
    await c.env.DB.prepare("select 1").first();
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 503);
  }
});

app.route("/api/v1", v1);
app.route("/api", api);
app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

export default {
  fetch: app.fetch,

  async email(message, env, ctx): Promise<void> {
    try {
      await ingestEmail(message, env, ctx);
    } catch (err) {
      // Never drop mail silently: a temp-fail makes the sender retry.
      console.error("ingest failed", message.to, err);
      message.setReject("451 4.3.0 Temporary failure storing message, please retry");
    }
  },

  async scheduled(event, env, ctx): Promise<void> {
    // Two schedules, told apart by cron rather than by a flag: the nightly one
    // backs up, the frequent one checks health. Backing up every few hours
    // would be waste; checking health once a day would let a broken domain sit
    // broken all day.
    const nightly = event.cron === "17 3 * * *";

    ctx.waitUntil(
      (async () => {
        if (nightly) {
          try {
            const result = await runBackup(env);
            const pruned = await pruneBackups(env);
            console.log(
              `backup ${result.key} — ${result.bytes} bytes in ${result.durationMs}ms, pruned ${pruned}`,
            );
          } catch (err) {
            console.error("backup failed", err);
          }
        }

        try {
          const db = drizzle(env.DB);
          const report = await runHealthCheck(db, env);
          if (report.healthy) return;

          console.error("health check found problems", JSON.stringify(report.findings));
          await sendHealthAlert(db, env, report);
        } catch (err) {
          console.error("health check failed", err);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
