import { beforeEach, describe, expect, it } from "vitest";
import { checkRateLimit, clearRateLimit, clientIp, recordFailure, type Limit } from "./ratelimit";

/** Minimal in-memory stand-in for the KV binding, including TTL expiry. */
function fakeKv() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    store,
    async get(key: string) {
      const hit = store.get(key);
      if (!hit) return null;
      if (hit.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return hit.value;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, {
        value,
        expiresAt: Date.now() + (opts?.expirationTtl ?? 3600) * 1000,
      });
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace & { store: Map<string, unknown> };
}

const limit: Limit = { max: 3, windowSeconds: 60 };

describe("rate limiting", () => {
  let kv: ReturnType<typeof fakeKv>;
  beforeEach(() => {
    kv = fakeKv();
  });

  it("allows attempts up to the cap, then blocks", async () => {
    for (let i = 0; i < limit.max; i++) {
      expect((await checkRateLimit(kv, "k", limit)).allowed).toBe(true);
      await recordFailure(kv, "k", limit);
    }
    const blocked = await checkRateLimit(kv, "k", limit);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("reports remaining attempts", async () => {
    expect((await checkRateLimit(kv, "k", limit)).remaining).toBe(2);
    await recordFailure(kv, "k", limit);
    expect((await checkRateLimit(kv, "k", limit)).remaining).toBe(1);
  });

  it("keeps buckets independent per key", async () => {
    for (let i = 0; i < limit.max; i++) await recordFailure(kv, "a", limit);
    expect((await checkRateLimit(kv, "a", limit)).allowed).toBe(false);
    expect((await checkRateLimit(kv, "b", limit)).allowed).toBe(true);
  });

  it("clears on success so a real user is not locked out", async () => {
    for (let i = 0; i < limit.max; i++) await recordFailure(kv, "k", limit);
    expect((await checkRateLimit(kv, "k", limit)).allowed).toBe(false);
    await clearRateLimit(kv, "k");
    expect((await checkRateLimit(kv, "k", limit)).allowed).toBe(true);
  });

  it("reopens once the window lapses", async () => {
    const brief: Limit = { max: 1, windowSeconds: 1 };
    await recordFailure(kv, "k", brief);
    expect((await checkRateLimit(kv, "k", brief)).allowed).toBe(false);
    // Rewind the stored window rather than sleeping.
    const entry = (kv.store as Map<string, { value: string }>).get("rl:k")!;
    entry.value = JSON.stringify({ count: 1, resetAt: Date.now() - 1 });
    expect((await checkRateLimit(kv, "k", brief)).allowed).toBe(true);
  });

  it("treats corrupt bucket data as no limit rather than throwing", async () => {
    await kv.put("rl:k", "not json");
    await expect(checkRateLimit(kv, "k", limit)).resolves.toMatchObject({ allowed: true });
    await expect(recordFailure(kv, "k", limit)).resolves.toBeUndefined();
  });
});

describe("clientIp", () => {
  it("reads the Cloudflare client header", () => {
    const r = new Request("https://x.test", { headers: { "cf-connecting-ip": "203.0.113.9" } });
    expect(clientIp(r)).toBe("203.0.113.9");
  });

  it("degrades to a shared bucket rather than skipping the limit", () => {
    expect(clientIp(new Request("https://x.test"))).toBe("unknown");
  });
});
