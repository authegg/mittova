/**
 * Fixed-window rate limiting on KV.
 *
 * Not exact — KV is eventually consistent, so concurrent requests can each read
 * a stale count and slip through. That is an acceptable trade for login
 * throttling: the goal is to make sustained guessing impractical, not to
 * enforce a precise quota. Durable Objects would be exact but cost a round trip
 * on every attempt.
 */

export interface Limit {
  /** Attempts permitted inside the window. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets, for Retry-After. */
  retryAfter: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  limit: Limit,
): Promise<LimitResult> {
  const now = Date.now();
  const raw = await kv.get(`rl:${key}`);
  let bucket: Bucket | null = null;
  try {
    bucket = raw ? (JSON.parse(raw) as Bucket) : null;
  } catch {
    bucket = null;
  }

  if (!bucket || bucket.resetAt <= now) {
    return { allowed: true, remaining: limit.max - 1, retryAfter: 0 };
  }
  if (bucket.count >= limit.max) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }
  return { allowed: true, remaining: limit.max - bucket.count - 1, retryAfter: 0 };
}

/** Count one failure against the window, starting a new window if needed. */
export async function recordFailure(kv: KVNamespace, key: string, limit: Limit): Promise<void> {
  const now = Date.now();
  const raw = await kv.get(`rl:${key}`);
  let bucket: Bucket | null = null;
  try {
    bucket = raw ? (JSON.parse(raw) as Bucket) : null;
  } catch {
    bucket = null;
  }

  const next: Bucket =
    bucket && bucket.resetAt > now
      ? { count: bucket.count + 1, resetAt: bucket.resetAt }
      : { count: 1, resetAt: now + limit.windowSeconds * 1000 };

  await kv.put(`rl:${key}`, JSON.stringify(next), {
    // Let KV expire the bucket so old keys never accumulate.
    expirationTtl: Math.max(60, Math.ceil((next.resetAt - now) / 1000) + 60),
  });
}

/** Clear the window after a success, so one bad day doesn't lock a real user out. */
export async function clearRateLimit(kv: KVNamespace, key: string): Promise<void> {
  await kv.delete(`rl:${key}`);
}

/**
 * Client address for per-IP limiting. Falls back to a constant when absent so
 * the limiter degrades to a global cap rather than silently not applying.
 */
export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}
