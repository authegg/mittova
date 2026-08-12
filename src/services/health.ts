import type { Db } from "../db/types";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import {
  domains as domainsTable,
  events,
  suppressions,
  webhookDeliveries,
  webhooks,
} from "../db/schema";
import { checkDomain } from "./domains";
import { listBackups } from "./backup";

/**
 * What is wrong right now, checked on a schedule.
 *
 * Motivated by a real failure: template save returned 500 for the better part
 * of an hour and nothing said so — it was found by someone poking at the app.
 *
 * Be clear about the limit. This watches state that can be read back: DNS that
 * has stopped resolving, endpoints that keep refusing, a bounce rate that has
 * jumped, a backup that did not run. It cannot see a route throwing, because a
 * throw leaves no trace in the database. Catching that needs either Cloudflare's
 * own error alerting or an uptime probe against /api/health, which is why that
 * endpoint exists and touches the database rather than answering a constant.
 */

export interface Finding {
  severity: "warn" | "bad";
  area: string;
  detail: string;
}

const DAY = 24 * 60 * 60 * 1000;

/** A domain whose records have stopped resolving stops receiving mail silently. */
async function checkDns(db: Db): Promise<Finding[]> {
  const rows = await db.select().from(domainsTable).all();
  const checks = await Promise.all(rows.map((d) => checkDomain(d.domain)));
  return checks
    .filter((c) => !c.summary.healthy)
    .map((c) => ({
      severity: "bad" as const,
      area: "dns",
      detail: `${c.domain} resolves ${c.summary.ok}/${c.summary.total} records; mail may not arrive`,
    }));
}

/**
 * An endpoint that has failed every recent attempt is down, not flapping.
 * Anything still succeeding sometimes is the customer's problem to notice.
 */
async function checkWebhooks(db: Db): Promise<Finding[]> {
  const hooks = await db.select().from(webhooks).where(eq(webhooks.enabled, 1)).all();
  const findings: Finding[] = [];

  for (const hook of hooks) {
    const recent = await db
      .select({ statusCode: webhookDeliveries.statusCode })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.webhookId, hook.id),
          gt(webhookDeliveries.createdAt, Date.now() - DAY),
        ),
      )
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(10)
      .all();

    if (recent.length < 3) continue;
    const ok = recent.filter(
      (d) => d.statusCode !== null && d.statusCode >= 200 && d.statusCode < 300,
    ).length;
    if (ok === 0) {
      findings.push({
        severity: "bad",
        area: "webhooks",
        detail: `${hook.url} failed all ${recent.length} recent deliveries`,
      });
    }
  }
  return findings;
}

/**
 * A jump in hard bounces is the early warning before a domain is blocked, and
 * it is visible days before deliverability actually falls over.
 */
async function checkBounces(db: Db): Promise<Finding[]> {
  const since = Date.now() - DAY;
  const [added] = await db
    .select({ n: sql<number>`count(*)` })
    .from(suppressions)
    .where(and(eq(suppressions.reason, "bounce"), gt(suppressions.createdAt, since)))
    .all();
  const [sent] = await db
    .select({ n: sql<number>`count(*)` })
    .from(events)
    .where(and(eq(events.type, "email.sent"), gt(events.createdAt, since)))
    .all();

  const bounced = Number(added?.n ?? 0);
  const total = Number(sent?.n ?? 0);
  // Below a handful the ratio is noise; one bounce out of two sends is not a
  // 50% bounce rate worth waking anyone for.
  if (bounced < 5 || total < 20) return [];

  const rate = bounced / total;
  if (rate < 0.05) return [];
  return [
    {
      severity: rate >= 0.1 ? "bad" : "warn",
      area: "deliverability",
      detail: `${bounced} hard bounces from ${total} sends in 24h (${Math.round(rate * 100)}%)`,
    },
  ];
}

/** A backup that stopped running is only discovered when one is needed. */
async function checkBackups(env: Env): Promise<Finding[]> {
  try {
    const backups = await listBackups(env);
    if (backups.length === 0) {
      return [{ severity: "warn", area: "backups", detail: "no backup has ever been taken" }];
    }
    const newest = Math.max(...backups.map((b) => Date.parse(b.uploaded)));
    const age = Date.now() - newest;
    // The cron is nightly, so a day and a half means one has been missed.
    if (age > 1.5 * DAY) {
      return [
        {
          severity: "bad",
          area: "backups",
          detail: `newest backup is ${Math.floor(age / DAY)} days old; the nightly job may have stopped`,
        },
      ];
    }
  } catch (err) {
    return [
      {
        severity: "bad",
        area: "backups",
        detail: `could not list backups: ${(err as Error).message}`,
      },
    ];
  }
  return [];
}

export interface HealthReport {
  checkedAt: number;
  healthy: boolean;
  findings: Finding[];
}

export async function runHealthCheck(db: Db, env: Env): Promise<HealthReport> {
  // Independent checks, so they run together rather than in series.
  const groups = await Promise.all([
    checkDns(db).catch((e: Error) => [
      { severity: "warn" as const, area: "dns", detail: `check failed: ${e.message}` },
    ]),
    checkWebhooks(db).catch(() => []),
    checkBounces(db).catch(() => []),
    checkBackups(env),
  ]);

  const findings = groups.flat();
  return { checkedAt: Date.now(), healthy: findings.length === 0, findings };
}

/**
 * Tell someone.
 *
 * Sent through the ordinary send path so an alert exercises the same machinery
 * as real mail — if sending is broken, the alert about it will not arrive
 * either, which is worth knowing rather than papering over.
 *
 * Silent when ALERT_EMAIL is unset, because a deployment that has not asked for
 * alerts should not have mail attempted on its behalf.
 */
export function alertBody(report: HealthReport): { subject: string; text: string } {
  const worst = report.findings.some((f) => f.severity === "bad") ? "problems" : "warnings";
  return {
    subject: `Mittova health: ${report.findings.length} ${worst}`,
    text: [
      `Checked ${new Date(report.checkedAt).toISOString()}.`,
      "",
      ...report.findings.map((f) => `[${f.severity}] ${f.area}: ${f.detail}`),
      "",
      "This is the scheduled health check. It watches state it can read back —",
      "DNS, webhook endpoints, bounce rate, backups. It cannot see a route",
      "throwing, so it is not a substitute for error alerting.",
    ].join("\n"),
  };
}
