import { useEffect, useMemo, useRef, type ChangeEvent, type KeyboardEvent } from "react";

/**
 * A small HTML code editor: a transparent textarea sitting exactly on top of a
 * highlighted copy of the same text, with a line-number gutter beside it.
 *
 * Hand-rolled rather than pulling in CodeMirror or Monaco. Either would be the
 * largest dependency in the project by a wide margin, for one screen, and the
 * rest of this codebase draws its own icons and parses its own HTML already.
 *
 * The whole trick is that the textarea and the <pre> must lay text out
 * identically — same font, size, line height, padding, wrapping — or the caret
 * drifts from the glyphs beneath it. Those properties live together in one CSS
 * rule for that reason; changing one without the other is what breaks it.
 */

const ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ESCAPE[c]);

/**
 * Highlights tags, attribute names, quoted values, comments and {{variables}}.
 *
 * Emits escaped text with spans; the result is set as innerHTML on an element
 * we own, so this escaping is the only thing standing between template source
 * and the dashboard's DOM. Every path out of here must go through esc() before
 * any span is added, not after — see the note in tag().
 */
export function highlight(src: string): string {
  let out = "";
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      out += vars(esc(src.slice(i)));
      break;
    }
    if (lt > i) out += vars(esc(src.slice(i, lt)));

    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt);
      const stop = end < 0 ? src.length : end + 3;
      out += `<span class="tok-comment">${esc(src.slice(lt, stop))}</span>`;
      i = stop;
      continue;
    }

    const gt = src.indexOf(">", lt);
    if (gt < 0) {
      out += esc(src.slice(lt));
      break;
    }

    out += tag(src.slice(lt, gt + 1));
    i = gt + 1;
  }
  return out;
}

function tag(raw: string): string {
  const m = /^<\/?\s*([a-zA-Z][\w-]*)/.exec(raw);
  if (!m) return esc(raw);

  const nameEnd = m[0].length;
  const head = `<span class="tok-punct">${esc(raw.slice(0, nameEnd - m[1].length))}</span>`;
  const name = `<span class="tok-tag">${esc(m[1])}</span>`;

  /**
   * Escape the whole remainder first, then decorate what is left.
   *
   * Escaping inside the replacer only covered what the pattern matched, and
   * everything it did not match was returned verbatim — so source like
   * `<p <style>…` put a live <style> element into the dashboard's own DOM.
   * `raw` runs from a `<` to the next `>`, so it can contain further `<`. The
   * references esc() introduces do not disturb the tokens this pattern looks
   * for, so escaping first costs nothing.
   */
  const rest = esc(raw.slice(nameEnd)).replace(
    /([a-zA-Z-]+)(\s*=\s*)("[^"]*"|'[^']*')?/g,
    (_all, attr: string, eq = "", value = "") =>
      `<span class="tok-attr">${attr}</span>${eq}` +
      (value ? `<span class="tok-string">${vars(value)}</span>` : ""),
  );

  return head + name + rest;
}

/** Placeholders are the part an author scans for, so they get their own colour. */
function vars(escaped: string): string {
  return escaped.replace(/\{\{[^{}]*\}\}/g, (v) => `<span class="tok-var">${v}</span>`);
}

export default function CodeEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);

  const lines = useMemo(() => value.split("\n").length, [value]);
  const marked = useMemo(
    // A trailing newline leaves no line box, so the last line number would sit
    // against nothing; a space gives it something to align to.
    () => highlight(value.endsWith("\n") ? `${value} ` : value),
    [value],
  );

  useEffect(() => {
    if (pre.current) pre.current.innerHTML = marked;
  }, [marked]);

  function sync() {
    const el = ta.current;
    if (!el) return;
    if (pre.current) {
      pre.current.scrollTop = el.scrollTop;
      pre.current.scrollLeft = el.scrollLeft;
    }
    if (gutter.current) gutter.current.scrollTop = el.scrollTop;
  }

  // Tab indents rather than leaving the field. Trapping focus is normally
  // wrong, but this is a code surface where Tab has a meaning, and Escape still
  // moves on for anyone using the keyboard.
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Tab" || e.shiftKey) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: t } = el;
    const next = `${value.slice(0, s)}  ${value.slice(t)}`;
    onChange(next);
    requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
  }

  return (
    <div className="code">
      <div className="code-gutter" ref={gutter} aria-hidden="true">
        {Array.from({ length: lines }, (_, n) => (
          <div key={n}>{n + 1}</div>
        ))}
      </div>

      <div className="code-scroll">
        <pre className="code-paint" ref={pre} aria-hidden="true" />
        <textarea
          ref={ta}
          className="code-input"
          value={value}
          placeholder={placeholder}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
          onScroll={sync}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
        />
      </div>
    </div>
  );
}
