/**
 * Split a SQL script into individual statements.
 *
 * D1's `exec` splits on newlines, which cannot carry a multi-line INSERT, and
 * `batch` wants one prepared statement per call. Neither will take a whole
 * script, so the demo seed has to be cut up before it can be run — and cutting
 * naively on `;` corrupts any statement containing one inside a string literal
 * or a comment.
 *
 * Understood: single-quoted strings with `''` as the escape, and `--` comments
 * to end of line. Deliberately not understood: dollar quoting, `/* *\/` blocks,
 * and double-quoted identifiers containing semicolons — none appear in the seed,
 * and a parser that silently half-handles more constructs than it really does is
 * worse than one with a stated boundary.
 *
 * Kept apart from demo.ts so it can be unit tested in node: demo.ts imports a
 * `.sql` text module, which only the bundler can resolve.
 */
export function splitStatements(script: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;

  for (let i = 0; i < script.length; i++) {
    const ch = script[i];

    if (inString) {
      current += ch;
      if (ch === "'") {
        // '' is an escaped quote, not the end of the string.
        if (script[i + 1] === "'") {
          current += script[++i];
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }

    // A comment runs to the end of the line. Dropped rather than kept: it is
    // never meaningful to the database, and keeping it risks a trailing
    // comment-only fragment being mistaken for a statement.
    if (ch === "-" && script[i + 1] === "-") {
      while (i < script.length && script[i] !== "\n") i++;
      current += "\n";
      continue;
    }

    if (ch === ";") {
      statements.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  statements.push(current);

  // Whitespace-only fragments come from the gaps between statements and from
  // comment-only lines; they are not statements and D1 rejects an empty one.
  return statements.map((s) => s.trim()).filter((s) => s.length > 0);
}
