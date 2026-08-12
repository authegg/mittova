import { describe, expect, it } from "vitest";
import { sanitiseEmailHtml, htmlToText, wrapForEmail } from "./html";

/**
 * The sanitiser is the only thing standing between a compromised session and
 * script inside mail that carries our DKIM signature, so the hostile cases are
 * asserted on absence of constructs rather than on exact output.
 */
describe("sanitiseEmailHtml", () => {
  const mustNotContain = (html: string) => {
    const out = sanitiseEmailHtml(html).toLowerCase();
    for (const bad of [
      "<script",
      "<style",
      "<iframe",
      "<object",
      "<embed",
      "javascript:",
      "onerror",
      "onclick",
      "onload",
    ]) {
      expect(out, `leaked ${bad} from: ${html}`).not.toContain(bad);
    }
    return out;
  };

  it("keeps allowlisted formatting", () => {
    const out = sanitiseEmailHtml("<p>Hi <b>bold</b> <i>it</i> <u>u</u></p><ul><li>a</li></ul>");
    expect(out).toBe("<p>Hi <b>bold</b> <i>it</i> <u>u</u></p><ul><li>a</li></ul>");
  });

  it("drops script and style along with their contents", () => {
    const out = mustNotContain('<p>ok</p><script>fetch("//evil")</script><style>b{}</style>');
    expect(out).toBe("<p>ok</p>");
    expect(out).not.toContain("evil");
  });

  it("strips every event handler attribute", () => {
    expect(mustNotContain('<p onclick="x()" onmouseover="y()">t</p>')).toBe("<p>t</p>");
  });

  it("removes unknown and dangerous elements", () => {
    mustNotContain('<iframe src="//evil"></iframe><object data="x"></object><embed src="x">');
    mustNotContain('<img src=x onerror="alert(1)">');
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    " javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox",
  ])("rejects hostile href %j", (href) => {
    const out = mustNotContain(`<a href="${href}">x</a>`);
    expect(out).not.toContain("href=");
  });

  it("keeps safe links and hardens them", () => {
    const out = sanitiseEmailHtml('<a href="https://example.com">x</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('target="_blank"');
    expect(sanitiseEmailHtml('<a href="mailto:a@b.com">m</a>')).toContain("mailto:a@b.com");
  });

  it("filters CSS to an allowlist of properties and safe values", () => {
    const out = sanitiseEmailHtml(
      '<div style="color:red;position:fixed;background:url(javascript:alert(1));font-weight:bold">x</div>',
    );
    expect(out).toContain("color:red");
    expect(out).toContain("font-weight:bold");
    expect(out).not.toContain("position");
    expect(out).not.toContain("url(");
  });

  it("hoists block elements out of paragraphs", () => {
    // execCommand emits this; <ul> inside <p> is invalid and renders badly.
    expect(sanitiseEmailHtml("<p>Intro:</p><p><ul><li>one</li></ul></p>")).toBe(
      "<p>Intro:</p><ul><li>one</li></ul>",
    );
    expect(sanitiseEmailHtml("<p>a<blockquote>q</blockquote></p>")).toBe(
      "<p>a</p><blockquote>q</blockquote>",
    );
  });

  it("closes tags left open and ignores stray closers", () => {
    expect(sanitiseEmailHtml("<p>unclosed <b>bold")).toBe("<p>unclosed <b>bold</b></p>");
    expect(sanitiseEmailHtml("</b></p>plain")).toBe("plain");
  });

  it("escapes text that only looks like markup", () => {
    expect(sanitiseEmailHtml("5 < 7 & 8 > 6")).toBe("5 &lt; 7 &amp; 8 &gt; 6");
  });

  it("survives malformed and adversarial input without throwing", () => {
    for (const input of [
      "<",
      "<<<>>>",
      "<p",
      "<p ",
      "<a href=",
      "<!-- c -->",
      "<![CDATA[x]]>",
      "",
      "   ",
    ]) {
      expect(() => sanitiseEmailHtml(input)).not.toThrow();
    }
  });

  it("is idempotent", () => {
    const once = sanitiseEmailHtml('<p onclick="x">a <a href="https://e.com">l</a></p>');
    expect(sanitiseEmailHtml(once)).toBe(once);
  });
});

describe("htmlToText", () => {
  it("renders list items as bullets on their own lines", () => {
    expect(htmlToText("<p>Hi</p><ul><li>one</li><li>two</li></ul>")).toBe("Hi\n• one\n• two");
  });

  it("decodes entities and collapses blank runs", () => {
    expect(htmlToText("<p>a &amp; b</p><p></p><p></p><p>c</p>")).toBe("a & b\n\nc");
  });

  it("drops tags without leaving markup behind", () => {
    expect(htmlToText('<div><b>x</b><br><a href="https://e.com">y</a></div>')).not.toContain("<");
  });
});

/**
 * A mail client supplies no typography of its own worth having: several still
 * default to a serif face, and all of them give <p> a full 1em margin top and
 * bottom, so paragraphs arrive with a blank line between them.
 */
describe("wrapForEmail", () => {
  it("wraps in a body with an inherited font and line height", () => {
    const out = wrapForEmail("<p>hi</p>");
    expect(out).toMatch(/^<div style="[^"]*line-height:1\.6[^"]*">/);
    expect(out).toContain("font-family:-apple-system");
    expect(out.endsWith("</div>")).toBe(true);
  });

  it("does not name a font the recipient cannot have", () => {
    expect(wrapForEmail("<p>hi</p>")).not.toContain("Geist");
  });

  // The actual complaint: default <p> margins put a blank line between every
  // paragraph, so they are replaced with a single bottom margin.
  it("gives paragraphs a bottom margin only", () => {
    expect(wrapForEmail("<p>a</p><p>b</p>")).toContain('<p style="margin:0 0 12px">');
  });

  it("styles every block that carries a default margin", () => {
    for (const tag of ["ul", "ol", "li", "blockquote", "pre", "h1", "h2", "h3"]) {
      expect(wrapForEmail(`<${tag}>x</${tag}>`)).toContain(`<${tag} style="margin:`);
    }
  });

  it("keeps existing attributes and lets author styles win", () => {
    const out = wrapForEmail('<p style="text-align:center;margin:40px 0">x</p>');
    // Defaults first, author's after, so the author's margin is the one applied.
    expect(out).toContain('style="margin:0 0 12px;text-align:center;margin:40px 0"');
  });

  it("leaves inline tags alone", () => {
    expect(wrapForEmail('<p>a <b>b</b> <a href="https://e.com">l</a></p>')).toContain(
      '<b>b</b> <a href="https://e.com">l</a>',
    );
  });

  it("does not restyle a tag it has no default for", () => {
    expect(wrapForEmail("<p>a<br>b</p>")).toContain("a<br>b");
  });

  it("survives an empty body", () => {
    expect(wrapForEmail("")).toMatch(/^<div style=".+"><\/div>$/);
  });

  // Applied once at send, never to stored drafts, so re-saving a draft cannot
  // accumulate wrappers. Guards the placement rather than the function.
  it("is not applied by the sanitiser", () => {
    expect(sanitiseEmailHtml("<p>hi</p>")).toBe("<p>hi</p>");
  });
});

/**
 * Templates are authored layouts, and HTML email layout is still tables, images
 * and inline styles. The composer's narrow allowlist flattened them: tables
 * collapsed to running text, images vanished, and entities double-escaped.
 */
describe("sanitiseEmailHtml layout mode", () => {
  const tpl =
    "<table width='100%'><tr><td align='center' style='padding:24px;background:#f6f6f6'>" +
    "<img src='https://cdn.x.com/logo.png' alt='Logo' width='120'>" +
    "<p style='font-size:18px'>Total: &#8369;1,200.00</p></td></tr></table>";

  it("keeps table structure", () => {
    const out = sanitiseEmailHtml(tpl, { layout: true });
    for (const tag of ["<table", "<tr>", "<td"]) expect(out).toContain(tag);
  });

  it("keeps images and their sizing", () => {
    const out = sanitiseEmailHtml(tpl, { layout: true });
    expect(out).toContain('src="https://cdn.x.com/logo.png"');
    expect(out).toContain('alt="Logo"');
    expect(out).toContain('width="120"');
  });

  it("keeps layout attributes and styles", () => {
    const out = sanitiseEmailHtml(tpl, { layout: true });
    expect(out).toContain('align="center"');
    expect(out).toContain("background:#f6f6f6");
  });

  it("leaves composed mail exactly as narrow as before", () => {
    const out = sanitiseEmailHtml(tpl);
    expect(out).not.toContain("<table");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("background:");
  });

  it("still refuses script, iframe, handlers and javascript URLs", () => {
    const out = sanitiseEmailHtml(
      "<table><tr><td onclick='x'><img src='javascript:alert(1)'>" +
        "<script>bad()</script><iframe src='https://e.com'></iframe>ok</td></tr></table>",
      { layout: true },
    );
    expect(out).toBe("<table><tr><td>ok</td></tr></table>");
  });

  it("drops an image whose source was refused rather than leaving a broken one", () => {
    expect(sanitiseEmailHtml("<img src='data:text/html,x'>", { layout: true })).toBe("");
  });

  it("allows cid: for an attached image", () => {
    expect(sanitiseEmailHtml("<img src='cid:logo@x'>", { layout: true })).toContain("cid:logo@x");
  });

  it("is idempotent", () => {
    const once = sanitiseEmailHtml(tpl, { layout: true });
    expect(sanitiseEmailHtml(once, { layout: true })).toBe(once);
  });
});

/**
 * &#8369; arriving as the literal text "&#8369;" was a peso sign turning into
 * markup in front of the recipient.
 */
describe("character references", () => {
  it("preserves decimal, hex and named references", () => {
    expect(sanitiseEmailHtml("&#8369;1,200")).toContain("&#8369;");
    expect(sanitiseEmailHtml("&#x20B1;")).toContain("&#x20B1;");
    expect(sanitiseEmailHtml("Tom &amp; Jerry")).toContain("&amp;");
    expect(sanitiseEmailHtml("&nbsp;")).toContain("&nbsp;");
  });

  it("still escapes a bare ampersand", () => {
    expect(sanitiseEmailHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
    expect(sanitiseEmailHtml("R&D")).toBe("R&amp;D");
    expect(sanitiseEmailHtml("ends with &")).toBe("ends with &amp;");
  });

  it("does not let a fake reference through", () => {
    expect(sanitiseEmailHtml("&notarealentitynamethatisfartoolong;")).toContain("&amp;");
  });

  it("stays idempotent, so a resave cannot double-escape", () => {
    const once = sanitiseEmailHtml("Total: &#8369;5 & up");
    expect(sanitiseEmailHtml(once)).toBe(once);
  });
});
