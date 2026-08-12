/**
 * Renders `site/content/comparison.json` into the page's HTML table, at build
 * time.
 *
 * That file is the single canonical source for the comparison: the README's
 * Markdown version is generated from it by `scripts/comparison.mjs`, and this
 * renders the same rows for the landing page. Neither copy is written by hand,
 * so the two cannot drift apart.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const SOURCE = join(here, "..", "content", "comparison.json");

type Column = { name: string; note: string; highlight: boolean };
type Row = { label: string; cells: string[] };
type Comparison = { caption: string; columns: Column[]; rows: Row[] };

function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Cell values may carry Markdown code spans — `` `POST /api/v1/emails` `` — so
 * that the same string reads correctly in the README. Everything outside the
 * backticks is escaped as text; the span itself becomes a <code>, with its
 * contents escaped too.
 */
export function inline(text: string): string {
  let out = "";
  let rest = text;
  for (;;) {
    const open = rest.indexOf("`");
    if (open === -1) break;
    const close = rest.indexOf("`", open + 1);
    if (close === -1) break;
    out += escape(rest.slice(0, open));
    out += `<code>${escape(rest.slice(open + 1, close))}</code>`;
    rest = rest.slice(close + 1);
  }
  return out + escape(rest);
}

export function read(): Comparison {
  const data = JSON.parse(readFileSync(SOURCE, "utf8")) as Comparison;
  for (const [i, row] of data.rows.entries()) {
    if (row.cells.length !== data.columns.length) {
      throw new Error(
        `comparison.json: row ${i + 1} ("${row.label}") has ${row.cells.length} cells, expected ${data.columns.length}`,
      );
    }
  }
  return data;
}

/**
 * A real table: one <th scope="col"> per approach, one <th scope="row"> per
 * question, so a screen reader announces "Mittova, Programmatic send" rather
 * than reading a grid of loose values.
 *
 * The first header cell is empty by design — it labels the row headers, and
 * inventing a word for it ("Feature") would be read out before every row.
 */
export function render(data: Comparison): string {
  const head = data.columns
    .map((col) => {
      const note = col.note ? `<span class="cmp-note">${escape(col.note)}</span>` : "";
      return `<th scope="col"${col.highlight ? ' class="cmp-mine"' : ""}><span class="cmp-name">${escape(col.name)}</span>${note}</th>`;
    })
    .join("\n            ");

  const body = data.rows
    .map((row) => {
      const cells = row.cells
        .map(
          (cell, i) =>
            `<td${data.columns[i]!.highlight ? ' class="cmp-mine"' : ""}>${inline(cell)}</td>`,
        )
        .join("\n              ");
      return `<tr>\n              <th scope="row">${inline(row.label)}</th>\n              ${cells}\n            </tr>`;
    })
    .join("\n            ");

  return `<table class="cmp">
          <caption class="visually-hidden">${escape(data.caption)}</caption>
          <thead>
            <tr>
              <td></td>
            ${head}
            </tr>
          </thead>
          <tbody>
            ${body}
          </tbody>
        </table>`;
}
