#!/usr/bin/env node
/**
 * Restore a Mittova NDJSON backup into a D1 database.
 *
 *   node scripts/restore.mjs <backup.ndjson> [--database mittova-mail] [--local]
 *
 * Inserts with OR REPLACE in dependency order, so it is safe to re-run and
 * safe against a partially populated target. Run the migrations first: this
 * restores rows, not schema.
 *
 * A backup you have never restored is a hope, not a backup — restore into a
 * scratch database and compare row counts before you rely on one.
 */

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrangler } from "./lib.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const database = args.includes("--database")
  ? args[args.indexOf("--database") + 1]
  : "mittova-mail";
const local = args.includes("--local");

if (!file) {
  console.error("usage: node scripts/restore.mjs <backup.ndjson> [--database NAME] [--local]");
  process.exit(1);
}

function quote(v) {
  if (v === null) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return `'${String(v).replaceAll("'", "''")}'`;
}

// The backup carries its own dependency-ordered table list, so this script
// never needs a second copy of the schema's ordering.
const byTable = new Map();
let meta = null;

for (const line of readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  if (row._meta) {
    meta = row;
    for (const t of row.tables ?? []) byTable.set(t, []);
    continue;
  }
  const { _table, ...rest } = row;
  if (!byTable.has(_table)) byTable.set(_table, []);
  byTable.get(_table).push(rest);
}

const ORDER = meta?.tables ?? [...byTable.keys()];
console.log(`Backup taken ${meta?.takenAt ?? "unknown"}`);

const statements = [];
for (const table of ORDER) {
  const rows = byTable.get(table) ?? [];
  if (rows.length === 0) continue;
  const cols = Object.keys(rows[0]);
  for (const row of rows) {
    statements.push(
      `INSERT OR REPLACE INTO ${table} (${cols.map((c) => `"${c}"`).join(",")}) ` +
        `VALUES (${cols.map((c) => quote(row[c])).join(",")});`,
    );
  }
  console.log(`  ${table.padEnd(16)} ${rows.length} rows`);
}

if (statements.length === 0) {
  console.log("Nothing to restore.");
  process.exit(0);
}

// defer_foreign_keys holds constraint checks until the transaction commits, so
// insert order cannot bite on a partial restore.
const sqlFile = join(tmpdir(), `mittova-restore-${Date.now()}.sql`);
writeFileSync(sqlFile, ["PRAGMA defer_foreign_keys=ON;", ...statements].join("\n"));

try {
  wrangler(
    ["d1", "execute", database, local ? "--local" : "--remote", "--yes", "--file", sqlFile],
    { quiet: false },
  );
  console.log(`\nRestored ${statements.length} rows into ${database}.`);
} finally {
  unlinkSync(sqlFile);
}
