/**
 * Template placeholders, defined once.
 *
 * There were four regexes for this — the editor's highlighter, the variable
 * list, the preview substitution and the server's renderTemplate — and they had
 * already drifted: the highlighter coloured `{{ first name }}` as a placeholder
 * that nothing else recognised, and the preview treated an empty value as unset
 * while a real send treated it as empty. One pattern and one substitution rule
 * removes that class of mismatch on the client; `renderTemplate` in
 * `src/services/send.ts` is its deliberate server-side twin and must match it.
 */
export const VARIABLE_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Placeholders used, in the order they first appear. */
export function variablesIn(...sources: string[]): string[] {
  const found = new Set<string>();
  for (const s of sources) {
    for (const m of s.matchAll(VARIABLE_RE)) found.add(m[1]);
  }
  return [...found];
}

/**
 * Substitute known values. An unset placeholder stays written as itself rather
 * than becoming a blank, so a missing one is visible instead of invisible.
 */
export function fillVariables(src: string, values: Record<string, string>): string {
  return src.replace(VARIABLE_RE, (whole, key: string) => values[key] || whole);
}
