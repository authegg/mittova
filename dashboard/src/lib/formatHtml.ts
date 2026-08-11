/**
 * Pretty-print email HTML.
 *
 * Deliberately structural rather than clever: it re-indents by nesting depth
 * and never rewrites attributes, quotes or entities, because a formatter that
 * edits markup is one you cannot run on a template already in production.
 *
 * The rule that keeps it safe is where it is allowed to break a line. Between
 * two block elements, whitespace is insignificant and a newline costs nothing.
 * Between inline elements it is a word boundary, so `Hello <b>there</b> friend`
 * must survive intact — breaking it would silently change the rendered text.
 * Inline runs are therefore copied through verbatim, and only block boundaries
 * become line breaks.
 */

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** Gets its own line and indents what it contains. Everything else is inline. */
const BLOCK = new Set([
  "html", "head", "body", "title", "meta", "link", "style",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
  "div", "p", "ul", "ol", "li", "blockquote", "pre", "hr", "center",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "footer", "section", "article", "main",
]);

/** Contents are literal; reindenting them changes what they render. */
const RAW = new Set(["pre", "textarea", "script", "style"]);

const INDENT = "  ";
const COLLAPSE_UNDER = 96;

export function formatHtml(src: string): string {
  const lines: string[] = [];
  let depth = 0;
  let inline = "";

  const flushInline = () => {
    const text = inline.trim();
    if (text) lines.push(INDENT.repeat(Math.max(0, depth)) + text);
    inline = "";
  };
  const emit = (line: string, at = depth) => {
    lines.push(INDENT.repeat(Math.max(0, at)) + line);
  };

  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      inline += src.slice(i);
      break;
    }
    inline += src.slice(i, lt);

    const gt = src.indexOf(">", lt);
    if (gt < 0) {
      inline += src.slice(lt);
      break;
    }

    const raw = src.slice(lt, gt + 1);
    const name = /^<\/?\s*([a-zA-Z][\w-]*)/.exec(raw)?.[1]?.toLowerCase() ?? "";
    const closing = raw.startsWith("</");
    const selfClosed = raw.endsWith("/>") || VOID.has(name);
    i = gt + 1;

    if (!BLOCK.has(name)) {
      // Inline tag, or something unrecognised: keep it with its neighbours
      // rather than guessing that a break is safe.
      inline += raw;
      continue;
    }

    flushInline();
    if (closing) {
      depth -= 1;
      emit(raw);
      continue;
    }

    // A raw element is emitted whole — open tag, contents, close tag — as a
    // single line that happens to contain newlines. Putting its open tag on its
    // own line would add a newline *inside* the element, which is content here:
    // reformat the same template twice and it grows a blank line every time.
    if (RAW.has(name) && !selfClosed) {
      const close = src.toLowerCase().indexOf(`</${name}`, i);
      const end = close < 0 ? src.length : src.indexOf(">", close) + 1;
      const stop = close < 0 || end === 0 ? src.length : end;
      emit(raw + src.slice(i, stop));
      i = stop;
      continue;
    }

    emit(raw);
    if (!selfClosed) depth += 1;
  }
  flushInline();

  return collapseShort(lines).join("\n");
}

/**
 * Pull `<td>`, its single line of content and `</td>` back together when the
 * whole thing is short. A table of one-word cells is three times taller
 * otherwise, and height is the thing that makes markup hard to scan.
 */
function collapseShort(lines: string[]): string[] {
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const open = lines[i];
    const body = lines[i + 1];
    const close = lines[i + 2];

    const openTag = /^\s*<([a-zA-Z][\w-]*)[^>]*>$/.exec(open)?.[1]?.toLowerCase();
    const closeTag = close && /^\s*<\/([a-zA-Z][\w-]*)>$/.exec(close)?.[1]?.toLowerCase();

    if (
      openTag &&
      // Never for raw elements: trimming their body is precisely the whitespace
      // the pass above went out of its way to preserve.
      !RAW.has(openTag) &&
      closeTag === openTag &&
      body !== undefined &&
      !body.trim().startsWith("<") &&
      open.length + body.trim().length + close.trim().length < COLLAPSE_UNDER
    ) {
      out.push(`${open}${body.trim()}${close.trim()}`);
      i += 2;
      continue;
    }
    out.push(open);
  }
  return out;
}
