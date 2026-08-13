/**
 * Is this deployment the public demo?
 *
 * Deliberately in its own module with no imports. The check itself is two
 * tokens, but it is needed by `send.ts` and `routes.ts`, and living beside the
 * reset meant those two dragged in `demo-seed.sql` — a text module — purely to
 * read a flag. That pulled a bundler rule into every toolchain that touches
 * them, including a hand-written Vite plugin so the node-side unit tests could
 * resolve a `.sql` import they had no use for.
 *
 * `demo.ts` re-exports both of these, so callers that do want the reset still
 * have one place to import from.
 */

/**
 * Exactly one value means yes.
 *
 * Not `Boolean(env.DEMO_MODE)`, and not a list of friendly spellings: an
 * unrecognised value must read as off, and a var that is present-but-empty on
 * every normal deployment must never read as on. That is the safe direction —
 * a demo with the flag missing merely goes stale, while a real deployment with
 * it wrongly on would refuse to send and empty itself on the hour.
 */
export function isDemo(env: Env): boolean {
  return env.DEMO_MODE === "1";
}

/** Thrown rather than returned: reaching this at all means something is wrong. */
export class DemoModeError extends Error {}
