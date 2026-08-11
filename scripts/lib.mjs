/** Shared plumbing for the setup and restore scripts. */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

/** Invoke wrangler with this project's cwd and stdio conventions. */
export function wrangler(args, { input, quiet = true } = {}) {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: root,
    input,
    encoding: "utf8",
    stdio: input
      ? ["pipe", "pipe", quiet ? "pipe" : "inherit"]
      : ["ignore", "pipe", quiet ? "pipe" : "inherit"],
  });
}
