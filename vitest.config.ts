import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Read on the node side and handed to the worker as a binding: workerd has no
 * host filesystem, so the tests cannot read the baseline themselves. Reading
 * the real migrations directory rather than a fixture is the point — if the
 * baseline ever ships broken, these fail before a deployment finds out.
 */
const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

/**
 * Two projects, because the tests need two different worlds.
 *
 * Pure logic — the sanitiser, the formatter, threading, passwords — runs in
 * node, which is fast and needs nothing. Anything that touches a route, a query
 * or the tenant filter runs inside workerd against a real D1, because that is
 * the only place those behave like they do in production: D1 ignores
 * `PRAGMA foreign_keys=OFF`, rejects OFFSET without LIMIT, and enforces the
 * unique indexes the isolation rules lean on. Every one of those has already
 * cost this project a production bug.
 */
/**
 * Teach the node side to read a `.sql` import as text.
 *
 * The Worker gets this from the `Text` rule in wrangler.jsonc, and the worker
 * test project from miniflare's `modulesRules`. The unit project has neither, so
 * anything it imports that transitively reaches the demo seed — `send.ts` does,
 * for the DEMO_MODE check — arrives at Vite's JavaScript parser and fails on the
 * first apostrophe in the SQL. Loading it here rather than restructuring the
 * modules keeps the three environments agreeing about what a `.sql` import is.
 */
const sqlAsText = {
  name: "sql-as-text",
  transform(code: string, id: string) {
    if (!id.endsWith(".sql")) return null;
    return { code: `export default ${JSON.stringify(code)};`, map: null };
  },
};

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [sqlAsText],
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "dashboard/src/**/*.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest({
            // Deliberately not wrangler.jsonc: it is gitignored because it holds
            // account and zone ids, so CI would have nothing to read.
            miniflare: {
              compatibilityDate: "2026-07-01",
              compatibilityFlags: ["nodejs_compat"],
              modulesRules: [{ type: "Text", include: ["**/*.sql"] }],
              d1Databases: ["DB"],
              kvNamespaces: ["SETTINGS"],
              r2Buckets: ["STORAGE"],
              bindings: {
                TEST_MIGRATIONS: migrations,
                APP_NAME: "Mittova",
                MAIL_DOMAIN: "alpha.test",
                WORKER_NAME: "mittova-test",
                ADMIN_EMAIL: "admin",
                ADMIN_PASSWORD: "test-admin-password",
                CF_ZONE_ID: "",
              },
            },
          }),
        ],
        test: {
          name: "worker",
          include: ["test/**/*.test.ts"],
          setupFiles: ["./test/setup.ts"],
          /**
           * These tests create accounts through the real API, and password
           * hashing is deliberately expensive: workerd caps deriveBits at 100k
           * iterations, so PBKDF2 runs as chained rounds. A suite whose setUp
           * hashes a password lands near the 5s default and fails on timing
           * rather than on behaviour, which is the least useful kind of red.
           */
          testTimeout: 20_000,
        },
      },
    ],
  },
});
