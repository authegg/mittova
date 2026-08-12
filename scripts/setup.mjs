#!/usr/bin/env node
/**
 * One-shot provisioning for a fresh Mittova deployment.
 *
 * Creates the D1 database, R2 bucket and KV namespace, writes wrangler.jsonc
 * from the example, sets the admin secret and applies migrations. Safe to
 * re-run: existing resources are detected and reused rather than duplicated.
 */

import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { c, root, wrangler } from "./lib.mjs";

const CONFIG = join(root, "wrangler.jsonc");
const EXAMPLE = join(root, "wrangler.example.jsonc");

function step(n, total, label) {
  console.log(`\n${c.bold(`[${n}/${total}]`)} ${label}`);
}

/** Read an id out of wrangler's output, whatever shape it decides to print. */
function extractId(output, patterns) {
  for (const p of patterns) {
    const m = output.match(p);
    if (m) return m[1];
  }
  return null;
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const total = 7;

  console.log(c.bold("\nMittova setup"));
  console.log(c.dim("Provisions Cloudflare resources and writes wrangler.jsonc.\n"));

  if (existsSync(CONFIG)) {
    const go = await rl.question("wrangler.jsonc already exists. Overwrite it? [y/N] ");
    if (go.trim().toLowerCase() !== "y") {
      console.log("Left the existing config alone. Nothing changed.");
      rl.close();
      return;
    }
  }

  /* ------------------------------------------------------------ identity -- */

  step(1, total, "Checking your Cloudflare login");
  let accountId = "";
  try {
    const who = wrangler(["whoami"]);
    const m = who.match(/([0-9a-f]{32})/i);
    accountId = m ? m[1] : "";
    console.log(c.dim(`  account ${accountId || "not detected"}`));
  } catch {
    console.log(c.red("  wrangler could not authenticate. Run `npx wrangler login` first."));
    rl.close();
    process.exitCode = 1;
    return;
  }

  accountId = (await rl.question(`Cloudflare account id [${accountId}]: `)).trim() || accountId;
  const domain = (await rl.question("Mail domain (for example example.com): ")).trim();
  if (!domain) {
    console.log(c.red("A domain is required."));
    rl.close();
    process.exitCode = 1;
    return;
  }
  const zoneId = (
    await rl.question(`Zone id for ${domain} (blank to skip routing automation): `)
  ).trim();

  /* ----------------------------------------------------------- resources -- */

  step(2, total, "Creating the D1 database");
  let databaseId = "";
  try {
    const out = wrangler(["d1", "create", "mittova-mail"]);
    databaseId = extractId(out, [/"database_id":\s*"([0-9a-f-]{36})"/i, /([0-9a-f-]{36})/i]) ?? "";
    console.log(c.green(`  created ${databaseId}`));
  } catch {
    const list = wrangler(["d1", "list", "--json"]);
    databaseId = JSON.parse(list).find((d) => d.name === "mittova-mail")?.uuid ?? "";
    console.log(c.dim(`  already exists, reusing ${databaseId}`));
  }

  step(3, total, "Creating the R2 bucket");
  try {
    wrangler(["r2", "bucket", "create", "mittova"]);
    console.log(c.green("  created mittova"));
  } catch {
    console.log(c.dim("  already exists, reusing mittova"));
  }

  step(4, total, "Creating the KV namespace");
  let kvId = "";
  try {
    const out = wrangler(["kv", "namespace", "create", "SETTINGS"]);
    kvId = extractId(out, [/"id":\s*"([0-9a-f]{32})"/i, /([0-9a-f]{32})/i]) ?? "";
    console.log(c.green(`  created ${kvId}`));
  } catch {
    const list = wrangler(["kv", "namespace", "list"]);
    kvId = JSON.parse(list).find((n) => n.title.endsWith("SETTINGS"))?.id ?? "";
    console.log(c.dim(`  already exists, reusing ${kvId}`));
  }

  /* -------------------------------------------------------------- config -- */

  step(5, total, "Writing wrangler.jsonc");
  const config = readFileSync(EXAMPLE, "utf8")
    .replace("<YOUR_CLOUDFLARE_ACCOUNT_ID>", accountId)
    .replace("<YOUR_D1_DATABASE_ID>", databaseId)
    .replace("<YOUR_KV_NAMESPACE_ID>", kvId)
    .replace("<YOUR_ZONE_ID>", zoneId)
    .replaceAll("<YOUR_DOMAIN>", domain);
  writeFileSync(CONFIG, config);
  console.log(c.green("  wrangler.jsonc written"));

  /* ------------------------------------------------------------- secrets -- */

  step(6, total, "Setting the administrator password");
  const password = randomBytes(18).toString("base64url");
  wrangler(["secret", "put", "ADMIN_PASSWORD"], { input: password });
  console.log(`  ${c.bold("Administrator password:")} ${c.green(password)}`);
  console.log(c.dim("  Store it now — it is not shown again and not recoverable."));

  if (zoneId) {
    console.log(
      c.dim(
        "\n  For automatic Email Routing rules, create a token scoped to\n" +
          "  Email Routing Rules: Edit on this zone only, then run:\n" +
          "    npx wrangler secret put CF_API_TOKEN",
      ),
    );
  }

  /* ---------------------------------------------------------- migrations -- */

  step(7, total, "Applying database migrations");
  wrangler(["d1", "migrations", "apply", "mittova-mail", "--remote"], { quiet: false });
  console.log(c.green("  schema applied"));

  console.log(c.bold("\nDone. Next:"));
  console.log("  npm run deploy");
  console.log(
    `  Enable Email Routing and Email Sending for ${domain} in the Cloudflare dashboard.`,
  );
  console.log(`  Sign in at https://mail.${domain} with an empty email and the password above.\n`);

  rl.close();
}

main().catch((err) => {
  console.error(c.red(`\nSetup failed: ${err.message}`));
  process.exitCode = 1;
});
