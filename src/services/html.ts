/**
 * Email-safe HTML sanitiser for outbound mail.
 *
 * Runs on the server for every send, including sends via API keys, so a
 * compromised session or key cannot put script into mail that carries your
 * domain's DKIM signature.
 *
 * Deliberately an allowlist, and deliberately conservative about what it emits:
 * mail clients strip <style> blocks and mangle modern CSS, so formatting has to
 * survive as inline styles on a small set of tags.
 */

const ALLOWED_TAGS = new Set([
  "p", "br", "div", "span", "b", "strong", "i", "em", "u", "s", "strike",
  "ul", "ol", "li", "blockquote", "a", "pre", "code",
  "h1", "h2", "h3", "h4", "hr",
]);

/** Per-tag attribute allowlist. Everything else is dropped. */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title"]),
};

/** Only these CSS properties survive, and only with simple values. */
const ALLOWED_STYLES = new Set([
  "color", "background-color", "font-weight", "font-style",
  "text-decoration", "text-align", "margin", "padding", "font-size",
]);

const VOID_TAGS = new Set(["br", "hr", "img", "col"]);

/**
 * The additional vocabulary a template needs.
 *
 * Templates are layouts authored by an account owner, not prose typed by
 * whoever is at the keyboard, and HTML email layout is still tables and inline
 * styles because that is what mail clients render. Composed mail keeps the
 * narrow set: a webmail composer has no business emitting a table, and widening
 * the default would widen it for every send.
 *
 * Script, iframe, object, embed, form and event handlers stay refused in both
 * modes, and an image source is held to the same scheme check as a link.
 */
const LAYOUT_TAGS = new Set([
  "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "caption", "colgroup", "col", "img", "center", "small", "sup", "sub",
  "h5", "h6",
]);

const LAYOUT_ATTRS: Record<string, Set<string>> = {
  table: new Set(["width", "height", "align", "bgcolor", "border", "cellpadding", "cellspacing", "role"]),
  td: new Set(["width", "height", "align", "valign", "bgcolor", "colspan", "rowspan"]),
  th: new Set(["width", "height", "align", "valign", "bgcolor", "colspan", "rowspan"]),
  tr: new Set(["align", "valign", "bgcolor", "height"]),
  col: new Set(["width", "span"]),
  colgroup: new Set(["width", "span"]),
  img: new Set(["src", "alt", "width", "height", "title"]),
};

/** CSS an email layout needs beyond what composed prose does. */
const LAYOUT_STYLES = new Set([
  "background", "border", "border-top", "border-right", "border-bottom", "border-left",
  "border-radius", "border-collapse", "border-spacing", "display", "width", "height",
  "max-width", "min-width", "line-height", "letter-spacing", "font-family", "vertical-align",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "text-transform", "white-space", "mso-line-height-rule",
]);

/**
 * Block elements that may not sit inside a <p>. execCommand happily emits
 * `<p><ul>…</ul></p>`, which is invalid and renders inconsistently across mail
 * clients, so an open paragraph is closed before one of these opens.
 */
const BLOCK_TAGS = new Set([
  "ul", "ol", "blockquote", "pre", "div", "h1", "h2", "h3", "h4", "hr", "p",
  "table", "center",
]);

/**
 * A bare & must be escaped, but one that already begins a character reference
 * must not: escaping &#8369; to &amp;#8369; is how a peso sign arrives as the
 * literal text "&#8369;". Named, decimal and hex references are all recognised.
 */
/**
 * Every & is escaped unless it already begins a character reference. Escaping
 * &#8369; to &amp;#8369; is how a peso sign arrives as the literal text
 * "&#8369;". Named, decimal and hex forms are all recognised; a bare & still
 * becomes &amp;.
 */
const CHAR_REF = /&(#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[a-zA-Z][a-zA-Z0-9]{1,31};)?/g;

function escapeText(s: string): string {
  return s
    .replace(CHAR_REF, (_m, ref?: string) => (ref ? `&${ref}` : "&amp;"))
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}

/** Reject anything that isn't a plain http(s) or mailto link. */
function safeHref(raw: string): string | null {
  const value = raw.trim();
  /**
   * One cleaned string, both validated and returned.
   *
   * This used to check a stripped copy and return the original, so
   * "\x00https://example.com" was accepted *because* of the stripping and then
   * emitted with the control byte still in it. Validating one string and
   * emitting another is the shape a bypass takes, even where — as here — the
   * allowlist below happens to hold anyway.
   *
   * Cleaning rather than refusing is deliberate: mail wraps long URLs, so a
   * real CR or LF inside an href is ordinary rather than an attack.
   */
  const clean = value.replace(/[\x00-\x1f\x7f]/g, "");
  const flat = clean.toLowerCase();
  if (flat.startsWith("http://") || flat.startsWith("https://") || flat.startsWith("mailto:")) {
    return clean;
  }
  return null;
}

function sanitiseStyle(raw: string, layout: boolean): string | null {
  const kept: string[] = [];
  for (const decl of raw.split(";")) {
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (!ALLOWED_STYLES.has(prop) && !(layout && LAYOUT_STYLES.has(prop))) continue;
    // url(), expression() and escapes are all vectors; allow plain values only.
    if (/[(){}\\<>]|url|expression|@import/i.test(value)) continue;
    if (value.length > (layout ? 160 : 80)) continue;
    kept.push(`${prop}:${value}`);
  }
  return kept.length ? kept.join(";") : null;
}

/**
 * Tokenise and rebuild rather than regex-replace in place: the only reliable
 * way to guarantee the output contains nothing but allowlisted constructs.
 */
export interface SanitiseOptions {
  /**
   * Allow the table, image and inline-style vocabulary an HTML email layout is
   * built from. For templates, which an owner authors deliberately — not for
   * prose typed into the composer.
   */
  layout?: boolean;
}

export function sanitiseEmailHtml(input: string, options: SanitiseOptions = {}): string {
  const layout = options.layout === true;
  const out: string[] = [];
  const open: string[] = [];
  let i = 0;

  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt < 0) {
      out.push(escapeText(input.slice(i)));
      break;
    }
    if (lt > i) out.push(escapeText(input.slice(i, lt)));

    const gt = input.indexOf(">", lt);
    if (gt < 0) {
      out.push(escapeText(input.slice(lt)));
      break;
    }

    const rawTag = input.slice(lt + 1, gt).trim();
    i = gt + 1;

    // Comments and processing instructions: drop entirely.
    if (rawTag.startsWith("!") || rawTag.startsWith("?")) continue;

    const isClose = rawTag.startsWith("/");
    const nameMatch = /^\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(rawTag);
    if (!nameMatch) {
      // Not a tag at all — prose like "5 < 7 & 8 > 6". Emit it as escaped text
      // rather than dropping it, which would silently eat the sender's words.
      out.push(escapeText(input.slice(lt, gt + 1)));
      continue;
    }
    const name = nameMatch[1].toLowerCase();

    // script/style content must not survive as text either.
    if (name === "script" || name === "style") {
      const closing = new RegExp(`</\\s*${name}\\s*>`, "i");
      const rest = input.slice(i);
      const m = closing.exec(rest);
      i = m ? i + m.index + m[0].length : input.length;
      continue;
    }

    if (!ALLOWED_TAGS.has(name) && !(layout && LAYOUT_TAGS.has(name))) continue;

    if (isClose) {
      const idx = open.lastIndexOf(name);
      if (idx >= 0) {
        // Close anything opened inside it, so the output stays well formed.
        for (let k = open.length - 1; k >= idx; k--) out.push(`</${open[k]}>`);
        open.splice(idx);
      }
      continue;
    }

    const attrs: string[] = [];
    const attrRe = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(rawTag))) {
      const key = a[1].toLowerCase();
      const value = a[3] ?? a[4] ?? a[5] ?? "";
      if (key.startsWith("on")) continue; // every event handler
      if (key === "style") {
        const style = sanitiseStyle(value, layout);
        if (style) attrs.push(`style="${escapeAttr(style)}"`);
        continue;
      }
      const permitted =
        ALLOWED_ATTRS[name]?.has(key) || (layout && LAYOUT_ATTRS[name]?.has(key));
      if (!permitted) continue;
      if (key === "href") {
        const href = safeHref(value);
        if (!href) continue;
        attrs.push(`href="${escapeAttr(href)}"`);
        continue;
      }
      // An image source is a URL the recipient's client will fetch, so it is
      // held to the same scheme check as a link, plus cid: for an attached one.
      if (key === "src") {
        // Same rule as href: emit the string that was checked, not the raw one.
        const src = safeHref(value);
        const clean = value.trim().replace(/[\u0000-\u0020]/g, "");
        if (!src && !clean.toLowerCase().startsWith("cid:")) continue;
        attrs.push(`src="${escapeAttr(src ?? clean)}"`);
        continue;
      }
      attrs.push(`${key}="${escapeAttr(value)}"`);
    }

    // Links leave our domain; never let the target document reach window.opener.
    if (name === "a") attrs.push('target="_blank"', 'rel="noopener noreferrer nofollow"');

    // An image whose source was refused is not an image; emitting a bare <img>
    // would leave a broken-picture icon in the recipient's client.
    if (name === "img" && !attrs.some((x) => x.startsWith("src="))) continue;

    // A paragraph cannot contain a block; close it rather than nest illegally.
    if (BLOCK_TAGS.has(name)) {
      const openP = open.lastIndexOf("p");
      if (openP >= 0) {
        for (let k = open.length - 1; k >= openP; k--) out.push(`</${open[k]}>`);
        open.splice(openP);
      }
    }

    const selfClosing = VOID_TAGS.has(name) || rawTag.endsWith("/");
    out.push(`<${name}${attrs.length ? " " + attrs.join(" ") : ""}>`);
    if (!selfClosing) open.push(name);
  }

  for (let k = open.length - 1; k >= 0; k--) out.push(`</${open[k]}>`);

  return (
    out
      .join("")
      // Closing a paragraph early to hoist a block out of it leaves an empty
      // shell behind. `<p><br></p>` is kept: that is a deliberate blank line.
      .replace(/<(p|div|blockquote)>\s*<\/\1>/g, "")
      .trim()
  );
}

/** Readable plain-text alternative, for clients that refuse HTML. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-4]|hr)\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "• ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ------------------------------------------------- outgoing presentation --- */

/**
 * Typography that a receiving mail client will not supply.
 *
 * A bare fragment inherits the client's defaults. Several of them still default
 * to a serif face, and every one of them gives `<p>` a full 1em margin above
 * *and* below, so consecutive paragraphs arrive separated by a blank line and
 * the message opens with a gap. It looks nothing like the composer.
 *
 * Inlined rather than written into a `<style>` block, because clients strip
 * those. font-family, font-size, line-height and colour inherit from the
 * wrapper, so they are set once; margins do not inherit, so blocks carry their
 * own. Defaults are written before any author styles, which in a single style
 * attribute means the author's win.
 *
 * The font stack is deliberately system fonts, not the dashboard's Geist: the
 * recipient does not have it, and naming it only costs a fallback hop.
 */
const EMAIL_BODY_STYLE =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
  "font-size:14px;line-height:1.6;color:#1a1917";

const BLOCK_STYLE: Record<string, string> = {
  p: "margin:0 0 12px",
  ul: "margin:0 0 12px;padding-left:22px",
  ol: "margin:0 0 12px;padding-left:22px",
  li: "margin:0 0 4px",
  blockquote:
    "margin:0 0 12px;padding:0 0 0 12px;border-left:3px solid #d9d6cf;color:#55524c",
  pre: "margin:0 0 12px;padding:10px 12px;background:#f7f6f3;border-radius:6px;" +
    "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;" +
    "white-space:pre-wrap",
  h1: "margin:20px 0 10px;font-size:20px;line-height:1.3",
  h2: "margin:18px 0 9px;font-size:17px;line-height:1.3",
  h3: "margin:16px 0 8px;font-size:15px;line-height:1.35",
};

/**
 * Wrap sanitised HTML for sending.
 *
 * Operates on the sanitiser's own output rather than arbitrary input, which is
 * why matching tags with a pattern is safe here: every tag has already been
 * rebuilt into a known shape.
 */
export function wrapForEmail(html: string): string {
  const styled = html.replace(
    /<(p|ul|ol|li|blockquote|pre|h1|h2|h3)((?:\s[^>]*)?)>/gi,
    (_m, tag: string, attrs: string) => {
      const base = BLOCK_STYLE[tag.toLowerCase()];
      if (!base) return `<${tag}${attrs}>`;

      const existing = attrs.match(/\sstyle="([^"]*)"/i);
      if (!existing) return `<${tag}${attrs} style="${base}">`;

      // Author declarations go last so they override the defaults.
      const merged = `${base};${existing[1]}`;
      return `<${tag}${attrs.replace(existing[0], ` style="${merged}"`)}>`;
    },
  );

  return `<div style="${EMAIL_BODY_STYLE}">${styled}</div>`;
}
