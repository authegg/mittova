/**
 * Cloudflare Turnstile on the two unauthenticated forms that turn a guess into
 * a session: sign-in and invite acceptance.
 *
 * Off unless both keys are set. Requiring both means a deployment holding only
 * the secret cannot lock everyone out by refusing tokens the dashboard was never
 * given a site key to obtain.
 */
export function turnstileSiteKey(env: Env): string | null {
  return env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SITE_KEY : null;
}

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** True when Turnstile is off, or the token verifies. Fails closed on any error. */
export async function passesTurnstile(
  env: Env,
  token: string | undefined,
  ip: string,
): Promise<boolean> {
  if (!turnstileSiteKey(env)) return true;
  if (!token) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET_KEY!);
  form.append("response", token);
  if (ip !== "unknown") form.append("remoteip", ip);
  try {
    const res = await fetch(SITEVERIFY, { method: "POST", body: form });
    return res.ok && (await res.json<{ success: boolean }>()).success === true;
  } catch {
    return false;
  }
}
