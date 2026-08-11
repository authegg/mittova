import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";

/**
 * The bearer API had no rate limit at all: the per-mailbox daily cap bounded
 * the total but nothing bounded the rate, so a leaked key could spend a whole
 * day's allowance in seconds — and burst sending is what gets a domain blocked
 * long before a daily cap matters.
 */
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://mittova.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function makeKey(org: string): Promise<string> {
  const login = await call("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-admin-password" }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const res = await call("/api/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-mittova-org": org },
    body: JSON.stringify({ name: "k", scope: "full" }),
  });
  return (await res.json<{ plaintext: string }>()).plaintext;
}

describe("bearer API rate limit", () => {
  beforeEach(async () => {
    const now = Date.now();
    await env.DB.prepare(
      "insert into organizations (id,name,slug,daily_send_limit,created_at) values (?,?,?,?,?)",
    )
      .bind("org_alpha", "alpha", "alpha", 0, now)
      .run();
  });

  it("refuses once the window is spent, and says how long to wait", async () => {
    const key = await makeKey("org_alpha");
    const headers = { authorization: `Bearer ${key}` };

    let limited: Response | null = null;
    // The cap is 120/minute. Walking past it proves the middleware is wired in,
    // which is the part that was missing — the limiter itself is unit-tested.
    for (let n = 0; n < 130; n++) {
      const res = await call("/api/v1/emails?limit=1", { headers });
      if (res.status === 429) {
        limited = res;
        break;
      }
    }

    expect(limited, "the rate limit never fired").not.toBeNull();
    expect(Number(limited!.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited!.text()).toContain("rate_limited");
  }, 30_000);

  it("limits each key separately, so one customer cannot throttle another", async () => {
    const first = await makeKey("org_alpha");
    for (let n = 0; n < 130; n++) {
      const res = await call("/api/v1/emails?limit=1", {
        headers: { authorization: `Bearer ${first}` },
      });
      if (res.status === 429) break;
    }

    const second = await makeKey("org_alpha");
    const res = await call("/api/v1/emails?limit=1", {
      headers: { authorization: `Bearer ${second}` },
    });
    expect(res.status, "a spent key throttled a different one").toBe(200);
  }, 30_000);
});
