/**
 * Bindings that `wrangler types` cannot produce a usable type for.
 *
 * The generated Env gives each `vars` entry the *literal* type of its value in
 * the config it read. That is fine for a value the code only passes along, like
 * CF_ZONE_ID, and useless for one the code compares: with DEMO_MODE declared as
 * `""` in an example config, `env.DEMO_MODE === "1"` is a compile error, because
 * the two literals provably never overlap.
 *
 * So DEMO_MODE is declared here as a plain optional string and left out of
 * wrangler.example.jsonc altogether — which is also the better documentation,
 * since a production template should not be advertising a flag that disables
 * sending and empties the database on the hour. The demo sets it in its own
 * config; see wrangler.demo.example.jsonc.
 *
 * Env is an interface, so this merges into the generated one.
 *
 * If you ever run `wrangler types` against the demo config rather than the
 * example, wrangler will emit its own `DEMO_MODE: "1"` and collide with this.
 * Generate types from wrangler.example.jsonc, as CI does.
 */
interface Env {
  /**
   * "1", and nothing else, marks this deployment as the throwaway public demo:
   * sending is refused and the database is reset hourly. See src/services/demo.ts
   * for why the match is exact.
   */
  DEMO_MODE?: string;
  /**
   * The break-glass password the demo publishes on its own sign-in screen, so a
   * visitor can get in.
   *
   * A plain var, and deliberately not read from the ADMIN_PASSWORD secret. The
   * operator sets both to the same value; serving the secret directly would mean
   * that a deployment which had DEMO_MODE wrongly set to "1" — already bad
   * enough — would also publish its administrator password to anyone who asked.
   * A var that only the demo's config defines is empty everywhere else, so the
   * worst case stays contained.
   */
  DEMO_PASSWORD?: string;
}
