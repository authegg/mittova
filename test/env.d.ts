import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    /** Read from ./migrations on the node side; workerd has no filesystem. */
    TEST_MIGRATIONS: D1Migration[];
  }
}
