import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import worker from "../src/index";
import { alertBody, runHealthCheck } from "../src/services/health";

async function call(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://mittova.test${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("health endpoint", () => {
  it("answers only after reaching the database", async () => {
    const res = await call("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("needs no credentials, so a probe can use it", async () => {
    // Every other /api route is behind auth; this one must not be, or an
    // uptime check cannot tell "down" from "not logged in".
    expect((await call("/api/health")).status).not.toBe(401);
  });
});

describe("scheduled health check", () => {
  // A brand new deployment has taken no backup, and saying so is right: the
  // nightly job not having run yet is worth knowing on day one too.
  it("reports only the missing backup on an empty deployment", async () => {
    const report = await runHealthCheck(drizzle(env.DB), env);
    expect(report.findings.map((f) => f.area)).toEqual(["backups"]);
    expect(report.findings[0].severity).toBe("warn");
  });

  it("reports an endpoint that has failed every recent attempt", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "insert into webhooks (id,url,event_types,secret,enabled,org_id,created_at) values (?,?,?,?,?,?,?)",
    )
      .bind("wh", "https://down.invalid/hook", '["*"]', "s", 1, "org_x", now)
      .run();
    for (let n = 0; n < 4; n++) {
      await env.DB.prepare(
        "insert into webhook_deliveries (id,webhook_id,event_type,status_code,error,duration_ms,created_at) values (?,?,?,?,?,?,?)",
      )
        .bind(`d${n}`, "wh", "email.sent", 500, null, 10, now - n * 1000)
        .run();
    }

    const report = await runHealthCheck(drizzle(env.DB), env);
    expect(report.healthy).toBe(false);
    expect(report.findings.some((f) => f.area === "webhooks")).toBe(true);
    expect(report.findings.find((f) => f.area === "webhooks")?.detail).toContain("down.invalid");
  });

  it("stays quiet for an endpoint that still succeeds sometimes", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "insert into webhooks (id,url,event_types,secret,enabled,org_id,created_at) values (?,?,?,?,?,?,?)",
    )
      .bind("wh", "https://flaky.invalid/hook", '["*"]', "s", 1, "org_x", now)
      .run();
    for (const [n, code] of [500, 500, 200].entries()) {
      await env.DB.prepare(
        "insert into webhook_deliveries (id,webhook_id,event_type,status_code,error,duration_ms,created_at) values (?,?,?,?,?,?,?)",
      )
        .bind(`d${n}`, "wh", "email.sent", code, null, 10, now - n * 1000)
        .run();
    }

    const report = await runHealthCheck(drizzle(env.DB), env);
    expect(report.findings.some((f) => f.area === "webhooks")).toBe(false);
  });

  // A ratio computed from a handful of sends is noise, and an alert that cries
  // wolf gets muted, which is worse than no alert.
  it("ignores a bounce ratio drawn from too few sends", async () => {
    const now = Date.now();
    for (let n = 0; n < 6; n++) {
      await env.DB.prepare(
        "insert into suppressions (id,email,reason,detail,org_id,created_at) values (?,?,?,?,?,?)",
      )
        .bind(`s${n}`, `b${n}@x.test`, "bounce", "", "org_x", now)
        .run();
    }
    const report = await runHealthCheck(drizzle(env.DB), env);
    expect(report.findings.some((f) => f.area === "deliverability")).toBe(false);
  });

  it("writes an alert that names each finding", () => {
    const body = alertBody({
      checkedAt: Date.now(),
      healthy: false,
      findings: [{ severity: "bad", area: "dns", detail: "example.com resolves 4/7 records" }],
    });
    expect(body.subject).toContain("1 problems");
    expect(body.text).toContain("example.com resolves 4/7 records");
    // Honest about its own blind spot.
    expect(body.text).toContain("cannot see a route");
  });
});
