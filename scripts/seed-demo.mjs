/**
 * Fill the local database with demo content, so `npm run dev` shows a dashboard
 * with something in it.
 *
 * The content itself lives in src/services/demo-seed.sql, which is also what the
 * public demo executes when it resets itself every hour. One file, two readers:
 * a local seed that had drifted from what demo.mittova.com shows would make
 * every screenshot and every bug report ambiguous.
 *
 * Everything in it is fabricated. The domains sit under .example, a reserved TLD
 * that can never be registered, so nothing can accidentally address a real
 * mailbox. Password and API key hashes are placeholders that correspond to no
 * credential: none of these accounts can be signed into, and none of the keys
 * has ever existed. Sign in with the ADMIN_PASSWORD from .dev.vars instead, by
 * leaving the email field empty.
 *
 * Local only. It refuses to touch a remote database, and it deletes before it
 * inserts, so never point it at anything you care about.
 *
 *   npm run seed:demo
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { c, root, wrangler } from "./lib.mjs";

const DB = "mittova-mail";
const SEED = join(root, "src", "services", "demo-seed.sql");

if (process.argv.includes("--remote")) {
  console.error(c.red("  Refusing: this script seeds the local database only."));
  console.error("  It deletes every row before inserting. Never point it at production.");
  process.exit(1);
}

try {
  console.log(c.bold("Seeding the local database with demo content"));

  // Handed to wrangler by path rather than copied to a temp file first: it is
  // already a plain .sql file, and one fewer copy is one fewer thing to diverge.
  wrangler(["d1", "execute", DB, "--local", "--file", SEED]);

  // Deliberately derived rather than written out. A hand-maintained tally here
  // would be a third thing to keep in step with the seed, and the first to be
  // wrong.
  const inserts = readFileSync(SEED, "utf8").match(/^INSERT INTO (\w+)/gm) ?? [];
  const tables = [...new Set(inserts.map((m) => m.replace("INSERT INTO ", "")))];
  console.log(`  ${c.green("done")} — ${tables.length} tables seeded: ${tables.join(", ")}`);
  console.log(c.dim("  Run `npm run dev`, then sign in with the ADMIN_PASSWORD from .dev.vars"));
  console.log(c.dim("  and an empty email field.\n"));
} catch (err) {
  console.error(c.red("  Failed."), err.stderr?.toString().trim() || err.message);
  console.error(c.dim("  Has the schema been applied? Try `npm run db:apply:local` first."));
  process.exitCode = 1;
}
