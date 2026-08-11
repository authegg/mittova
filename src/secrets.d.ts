/**
 * Secrets, declared here because generated types cannot see them.
 *
 * `wrangler types` learns bindings from wrangler.jsonc but learns secrets from
 * the deployed Worker, so a machine that has never authenticated — CI, or a
 * fresh clone — generates an Env without these and every use fails to compile.
 * Env is an interface, so this merges into it.
 *
 * Set them with `wrangler secret put`; they are never in any committed file.
 */
interface Env {
  /** Break-glass owner login, used with an empty email address. */
  ADMIN_PASSWORD: string;
  /**
   * Scoped Cloudflare token: Email Routing Rules read/write, Zone read and
   * Email Sending read/write across every zone on the account. Absent means
   * routing rules and sending onboarding are managed by hand.
   */
  CF_API_TOKEN: string;
  /**
   * Where the scheduled health check sends its findings. Optional: unset means
   * no alert mail is attempted at all, which is the right default for a
   * deployment that has not asked for it.
   */
  ALERT_EMAIL?: string;
}
