import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { DEMO_RESET_CRON, DemoModeError, resetDemoData } from "../src/services/demo";

/**
 * The two things that make a public demo safe to leave on the internet, and the
 * one thing that would make it a catastrophe on a real deployment.
 *
 * Every test here asserts the *positive* first — that the action really happens
 * when it is supposed to — before asserting it is refused. A test that only
 * checks "nothing was sent" or "nothing was deleted" passes when nothing
 * happened at all, and this project has already shipped one exactly like that:
 * there is no `send_email` binding under test, so the send failed before the
 * code under test was reached and an empty result read as success.
 *
 * Driven end to end from the HTTP request and from the real `scheduled` handler,
 * because the gate is only correct if the route, the service and the dispatch by
 * cron all agree.
 */

/** The demo. Spread rather than mutated, so no test can leak the flag to another. */
const demoEnv = { ...env, DEMO_MODE: "1" };

/** A deployment that is not the demo: exactly what CI and production look like. */
const realEnv = env;

async function call(
  path: string,
  init: RequestInit = {},
  cookie?: string,
  useEnv: Env = realEnv,
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://mittova.test${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...init.headers,
      },
    }),
    useEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const json = (v: unknown) => JSON.stringify(v);

/** The break-glass admin, which is how a visitor signs into the demo. */
async function signInAsAdmin(useEnv: Env = realEnv): Promise<string> {
  const res = await call(
    "/api/auth/login",
    { method: "POST", body: json({ password: "test-admin-password" }) },
    undefined,
    useEnv,
  );
  expect(res.status, "admin sign-in").toBe(200);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

/** One tenant with somewhere to send from. */
async function seedTenant() {
  const now = Date.now();
  const rows: [string, unknown[]][] = [
    [
      "insert into organizations (id,name,slug,created_at) values (?,?,?,?)",
      ["org_alpha", "Alpha", "alpha", now],
    ],
    [
      "insert into domains (id,domain,zone_id,org_id,created_at) values (?,?,?,?,?)",
      ["d_alpha", "alpha.test", "", "org_alpha", now],
    ],
    [
      "insert into mailboxes (id,address,name,daily_send_limit,reply_to,org_id,created_at) values (?,?,?,?,?,?,?)",
      ["mb_alpha", "desk@alpha.test", "Desk", 200, "", "org_alpha", now],
    ],
  ];
  for (const [sql, args] of rows)
    await env.DB.prepare(sql)
      .bind(...args)
      .run();
}

/** Run the real scheduled handler for one cron expression. */
async function runCron(cron: string, useEnv: Env): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(
    { cron, scheduledTime: Date.now(), noRetry: () => {} } as unknown as ScheduledController,
    useEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
}

const countMessages = async (): Promise<number> =>
  Number(
    (await env.DB.prepare("select count(*) as n from messages").first<{ n: number }>())?.n ?? 0,
  );

/* ------------------------------------------------------------- sending --- */

describe("the demo never sends mail", () => {
  beforeEach(seedTenant);

  it("refuses a dashboard send, and only because of DEMO_MODE", async () => {
    const body = json({
      mailboxId: "mb_alpha",
      to: ["someone@example.com"],
      subject: "Hello",
      text: "Hello",
    });

    /*
     * The positive half. Without the flag this exact request runs the whole
     * send path and only fails at the wire, because the test environment has no
     * `send_email` binding — a 502 out of the EMAIL.send catch. That is the
     * proof that the 403 below is the demo gate stopping it, and not the
     * request being malformed, unauthorised or rejected earlier for some
     * unrelated reason.
     */
    const real = await call(
      "/api/send",
      { method: "POST", body, headers: { "x-mittova-org": "org_alpha" } },
      await signInAsAdmin(),
    );
    expect(real.status, "a non-demo deployment reaches the wire").toBe(502);

    const demo = await call(
      "/api/send",
      { method: "POST", body, headers: { "x-mittova-org": "org_alpha" } },
      await signInAsAdmin(demoEnv),
      demoEnv,
    );
    expect(demo.status).toBe(403);
    expect(await demo.json()).toMatchObject({ code: "E_DEMO_MODE" });
  });

  it("refuses an API-key send on the public v1 endpoint", async () => {
    // A key whose SHA-256 is known, so the bearer path can actually be driven.
    const plaintext = "mv_live_demo_test_key";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plaintext));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

    await env.DB.prepare(
      "insert into api_keys (id,name,hash,preview,scope,restrict_mailbox_id,org_id,created_at) values (?,?,?,?,?,?,?,?)",
    )
      .bind("key_a", "Test", hash, "mv_live_…", "sending", "mb_alpha", "org_alpha", Date.now())
      .run();

    const body = json({ to: ["someone@example.com"], subject: "Hi", text: "Hi" });
    const headers = { authorization: `Bearer ${plaintext}` };

    // Positive first, as above: the key works and the send reaches the wire.
    const real = await call("/api/v1/emails", { method: "POST", body, headers });
    expect(real.status, "the key itself is valid and authorised").toBe(502);

    const demo = await call(
      "/api/v1/emails",
      { method: "POST", body, headers },
      undefined,
      demoEnv,
    );
    expect(demo.status).toBe(403);
    expect(await demo.text()).toContain("E_DEMO_MODE");
  });
});

/* --------------------------------------------------------------- badge --- */

describe("the demo announces itself, and nothing else does", () => {
  it("reports demo details only when DEMO_MODE is set", async () => {
    // The dashboard renders its banner and publishes the sign-in password from
    // this one field, so a real deployment leaking a non-null `demo` would tell
    // its users their real mail is fabricated — and hand out a password.
    const real = await (await call("/api/auth/me")).json<{ demo: unknown }>();
    expect(real.demo, "a real deployment is never a demo").toBeNull();

    const demo = await (
      await call("/api/auth/me", {}, undefined, { ...demoEnv, DEMO_PASSWORD: "demo" })
    ).json<{ demo: { password: string } | null }>();
    expect(demo.demo).toEqual({ password: "demo" });
  });

  it("never serves the ADMIN_PASSWORD secret itself", async () => {
    // DEMO_PASSWORD is a separate var precisely so that the published value and
    // the real administrator credential are not the same string in the code. A
    // demo with the var unset publishes nothing rather than the secret.
    const body = await (await call("/api/auth/me", {}, undefined, demoEnv)).text();
    expect(body).toContain('"demo":{"password":""}');
    expect(body, "the break-glass secret must never be serialised").not.toContain(
      "test-admin-password",
    );
  });
});

/* --------------------------------------------------------------- reset --- */

describe("the hourly reset fails closed", () => {
  beforeEach(seedTenant);

  /** A row that only a wipe would remove. */
  async function markerRow(): Promise<void> {
    await env.DB.prepare(
      "insert into messages (id,mailbox_id,direction,thread_id,from_addr,to_addr,subject,snippet,size,seen,archived,starred,created_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        "msg_marker",
        "mb_alpha",
        "in",
        "thr_marker",
        "someone@example.com",
        "desk@alpha.test",
        "Not from the seed",
        "Not from the seed",
        10,
        0,
        0,
        0,
        Date.now(),
      )
      .run();
  }

  it("resets on the hourly cron when DEMO_MODE is set", async () => {
    await markerRow();
    await runCron(DEMO_RESET_CRON, demoEnv);

    const marker = await env.DB.prepare("select id from messages where id = 'msg_marker'").first();
    expect(marker, "the visitor's row should be gone").toBeNull();

    // And the seed really landed, rather than the database merely being empty.
    const seeded = await env.DB.prepare(
      "select id from organizations where id = 'org_demo'",
    ).first();
    expect(seeded, "the seed should have been applied").not.toBeNull();
    expect(await countMessages()).toBeGreaterThan(0);
  });

  it("does nothing on the hourly cron when DEMO_MODE is absent", async () => {
    await markerRow();
    const before = await countMessages();

    await runCron(DEMO_RESET_CRON, realEnv);

    expect(await countMessages(), "a real deployment must not be wiped").toBe(before);
    const marker = await env.DB.prepare("select id from messages where id = 'msg_marker'").first();
    expect(marker, "the row must survive").not.toBeNull();
    const seeded = await env.DB.prepare(
      "select id from organizations where id = 'org_demo'",
    ).first();
    expect(seeded, "the demo seed must not have been applied").toBeNull();
  });

  it("does not even attempt the reset on a real deployment", async () => {
    /*
     * The outer guard in `scheduled`, tested apart from the inner one in
     * `resetDemoData`.
     *
     * Both refuse, so the *outcome* is identical either way and every other
     * test here passes with one of them deleted — which is exactly what a
     * mutation of the outer guard proved. The difference is observable only in
     * whether the attempt was made at all: with the outer guard gone, the reset
     * is called, throws DemoModeError, and the handler logs the failure. Two
     * independent stops are worth having only if removing one of them fails
     * something.
     */
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      await runCron(DEMO_RESET_CRON, realEnv);
    } finally {
      console.error = original;
    }

    const attempted = errors.some((args) => String(args[0]).includes("demo reset failed"));
    expect(attempted, "a real deployment must not reach resetDemoData at all").toBe(false);
  });

  it("does nothing on any other cron, even with DEMO_MODE set", async () => {
    await markerRow();

    for (const cron of ["17 3 * * *", "23 */6 * * *", "*/5 * * * *"]) {
      await runCron(cron, demoEnv);
      const marker = await env.DB.prepare(
        "select id from messages where id = 'msg_marker'",
      ).first();
      expect(marker, `cron "${cron}" must not reset`).not.toBeNull();
    }
  });

  it("refuses when called directly without the flag", async () => {
    await expect(resetDemoData(realEnv)).rejects.toBeInstanceOf(DemoModeError);

    // Not merely thrown — nothing must have been written before it threw.
    const seeded = await env.DB.prepare(
      "select id from organizations where id = 'org_demo'",
    ).first();
    expect(seeded).toBeNull();
  });

  it("seeds content a visitor can actually use", async () => {
    await resetDemoData(demoEnv);

    // Two tenants, so the organization switcher has somewhere to go.
    const orgs = await env.DB.prepare("select count(*) as n from organizations").first<{
      n: number;
    }>();
    expect(Number(orgs?.n)).toBe(2);

    // Full-text search works, which means the FTS5 triggers fired on the seed.
    const hit = await env.DB.prepare(
      "select mid from messages_fts where messages_fts match ? limit 1",
    )
      .bind("pallet")
      .first();
    expect(hit, "search should find seeded mail").not.toBeNull();

    // Raw source is stored, so "view raw" does not 404 on the demo.
    const raw = await env.STORAGE.get("northwind.example/raw/mb_hello/msg_1.eml");
    expect(raw, "raw MIME should be in R2").not.toBeNull();
    expect(await raw!.text()).toContain("Subject: Re: Bulk order for the autumn catalogue");
  });
});

/* -------------------------------------------------------------- backup --- */

describe("the demo takes no backups", () => {
  beforeEach(seedTenant);

  const backups = async (): Promise<number> =>
    (await env.STORAGE.list({ prefix: "_backups/" })).objects.length;

  it("writes a nightly backup on a real deployment but not on the demo", async () => {
    // Positive first: the nightly cron really does produce an object, so the
    // absence below means "skipped" rather than "backups never worked here".
    await runCron("17 3 * * *", realEnv);
    expect(await backups(), "a real deployment backs up").toBeGreaterThan(0);

    for (const object of (await env.STORAGE.list({ prefix: "_backups/" })).objects) {
      await env.STORAGE.delete(object.key);
    }

    await runCron("17 3 * * *", demoEnv);
    expect(await backups(), "the demo must not back up fabricated rows").toBe(0);
  });

  it("refuses the manual backup button on the demo", async () => {
    /*
     * The scheduled backup was blocked and the manual one was not, which made
     * "the demo takes no backups" false for the only path a visitor can reach:
     * `/backups` is requirePlatformAdmin, and on the demo the published
     * break-glass login IS a platform administrator. Every visitor had a button
     * that appended to R2 with no route to undo it.
     */
    const body = { method: "POST" };

    // Positive first: on a real deployment the button genuinely works, so the
    // 403 below is the demo refusing rather than the route being broken.
    const real = await call("/api/backups", body, await signInAsAdmin());
    expect(real.status, "a real deployment can back up on demand").toBe(201);
    expect(await backups()).toBeGreaterThan(0);

    const demo = await call("/api/backups", body, await signInAsAdmin(demoEnv), demoEnv);
    expect(demo.status).toBe(403);
  });

  it("sweeps backups a visitor left behind when it resets", async () => {
    // The second, independent stop. Wiping tables never touched R2, so anything
    // written under the backup prefix outlived every reset.
    await env.STORAGE.put("_backups/2026-08-12/left-behind.ndjson", "{}");
    expect(await backups()).toBe(1);

    const result = await resetDemoData(demoEnv);
    expect(result.backupsSwept).toBe(1);
    expect(await backups(), "the reset must clear R2 as well as D1").toBe(0);
  });
});
