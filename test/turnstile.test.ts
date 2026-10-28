import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

/**
 * Turnstile on sign-in, driven from the HTTP request. siteverify is stubbed:
 * the real one is on the internet, and what is under test is that the route
 * asks it and obeys the answer.
 */
const guarded = { ...env, TURNSTILE_SITE_KEY: "site-key", TURNSTILE_SECRET_KEY: "secret-key" };

async function signIn(useEnv: Env, extra: Record<string, unknown> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://mittova.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-admin-password", ...extra }),
    }),
    useEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

/** Answers siteverify with `success`, and records what it was asked. */
function stubSiteverify(success: boolean) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://challenges.cloudflare.com/")) throw new Error(`unexpected ${url}`);
    return Response.json({ success });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("turnstile on sign-in", () => {
  it("signs in with a token siteverify accepts, and sends it the secret and token", async () => {
    const verify = stubSiteverify(true);
    const res = await signIn(guarded, { turnstileToken: "good" });
    expect(res.status).toBe(200);

    expect(verify).toHaveBeenCalledOnce();
    const form = verify.mock.calls[0][1]!.body as FormData;
    expect(form.get("secret")).toBe("secret-key");
    expect(form.get("response")).toBe("good");
  });

  it("refuses the right password when siteverify rejects the token", async () => {
    stubSiteverify(false);
    const res = await signIn(guarded, { turnstileToken: "bad" });
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses the right password with no token at all, without asking siteverify", async () => {
    const verify = stubSiteverify(true);
    const res = await signIn(guarded);
    expect(res.status).toBe(400);
    expect(verify).not.toHaveBeenCalled();
  });

  it("is off, and advertised as off, unless both keys are set", async () => {
    const verify = stubSiteverify(false);
    const halfSet = { ...env, TURNSTILE_SECRET_KEY: "secret-key" };
    expect((await signIn(halfSet)).status).toBe(200);
    expect(verify).not.toHaveBeenCalled();

    const ctx = createExecutionContext();
    const me = await worker.fetch(new Request("https://mittova.test/api/auth/me"), halfSet, ctx);
    expect((await me.json<{ turnstileSiteKey: unknown }>()).turnstileSiteKey).toBeNull();
    const on = await worker.fetch(new Request("https://mittova.test/api/auth/me"), guarded, ctx);
    expect((await on.json<{ turnstileSiteKey: unknown }>()).turnstileSiteKey).toBe("site-key");
  });
});

describe("turnstile on invite acceptance", () => {
  it("refuses before the invite is even looked up", async () => {
    stubSiteverify(false);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://mittova.test/api/auth/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "t",
          password: "A long enough password 1",
          turnstileToken: "x",
        }),
      }),
      guarded,
      ctx,
    );
    expect(res.status).toBe(400);
    // The verification message, not the invalid-invite one, so the check ran first.
    expect(await res.text()).toContain("verification");
  });
});
