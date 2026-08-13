/**
 * Regenerate the README's comparison table from the one canonical source.
 *
 * The table is the strongest thing either the README or the landing page has to
 * say, and it was previously going to exist twice — once in each — which is a
 * guarantee that one of them eventually lies. `site/content/comparison.json` is
 * the single source: the landing page renders it at build time, and this script
 * writes the Markdown form into README.md between the marker comments.
 *
 *   node scripts/comparison.mjs           # rewrite the README block
 *   node scripts/comparison.mjs --check   # fail if it is out of date (CI)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { c, root } from "./lib.mjs";

const SOURCE = join(root, "site", "content", "comparison.json");
const README = join(root, "README.md");

const START = "<!-- comparison:start -->";
const END = "<!-- comparison:end -->";

/**
 * A pipe inside a cell would end the cell.
 *
 * The HTML renderer escapes nothing because HTML does not care, so a value like
 * `Yes | with a caveat` would add a column to one Markdown row and misalign the
 * table while the landing page stayed correct — the two representations
 * disagreeing, which is the exact thing one canonical source exists to prevent.
 * `--check` cannot catch it either: it compares generated output against
 * generated output, so both sides would be wrong together.
 */
const cell = (value) => String(value).replace(/\|/g, "\\|");

/** A column heading, with its qualifier on a second line. */
function heading(col) {
  const name = col.highlight ? `**${cell(col.name)}**` : cell(col.name);
  return col.note ? `${name}<br>${cell(col.note)}` : name;
}

function renderMarkdown(data) {
  const head = `|  | ${data.columns.map(heading).join(" | ")} |`;
  const rule = `|${"---|".repeat(data.columns.length + 1)}`;
  const rows = data.rows.map((r) => `| ${cell(r.label)} | ${r.cells.map(cell).join(" | ")} |`);
  return [head, rule, ...rows].join("\n");
}

const data = JSON.parse(readFileSync(SOURCE, "utf8"));

for (const [i, row] of data.rows.entries()) {
  if (row.cells.length !== data.columns.length) {
    console.error(
      c.red(
        `  Row ${i + 1} ("${row.label}") has ${row.cells.length} cells, expected ${data.columns.length}.`,
      ),
    );
    process.exit(1);
  }
}

const table = renderMarkdown(data);
const readme = readFileSync(README, "utf8");

const from = readme.indexOf(START);
const to = readme.indexOf(END);
if (from === -1 || to === -1 || to < from) {
  console.error(c.red(`  README.md is missing the ${START} / ${END} markers.`));
  process.exit(1);
}

const before = readme.slice(0, from + START.length);
const after = readme.slice(to);
const updated = `${before}\n\n${table}\n\n${after}`;

if (process.argv.includes("--check")) {
  if (updated !== readme) {
    console.error(c.red("  The README comparison table is out of date."));
    console.error("  It is generated from site/content/comparison.json — the landing page renders");
    console.error("  the same data, so the two cannot be edited separately.");
    console.error(c.dim("  Run `npm run comparison` and commit the result."));
    process.exit(1);
  }
  console.log(`  ${c.green("ok")} — README comparison table matches site/content/comparison.json`);
} else if (updated === readme) {
  console.log(`  ${c.dim("unchanged")} — README comparison table already matches`);
} else {
  writeFileSync(README, updated);
  console.log(`  ${c.green("written")} — README comparison table regenerated`);
}
