import { describe, expect, it } from "vitest";
import { formatHtml } from "./formatHtml";

/**
 * A formatter that edits markup is one you cannot run on a template already in
 * production, so the property that matters most is that nothing changes except
 * whitespace between tags.
 */
describe("formatHtml", () => {
  it("indents by nesting depth", () => {
    expect(formatHtml("<table><tr><td>x</td></tr></table>")).toBe(
      ["<table>", "  <tr>", "    <td>x</td>", "  </tr>", "</table>"].join("\n"),
    );
  });

  it("does not indent past a void element", () => {
    expect(formatHtml("<div><img src='a.png'><p>after</p></div>")).toBe(
      ["<div>", "  <img src='a.png'>", "  <p>after</p>", "</div>"].join("\n"),
    );
  });

  it("leaves attributes exactly as written", () => {
    const out = formatHtml(`<td align='center' style="padding:24px;background:#f6f6f4">x</td>`);
    expect(out).toContain(`align='center'`);
    expect(out).toContain(`style="padding:24px;background:#f6f6f4"`);
  });

  it("keeps whitespace inside pre untouched", () => {
    const src = "<div><pre>  keep\n    this  </pre></div>";
    expect(formatHtml(src)).toContain("  keep\n    this  ");
  });

  // The important one: breaking between inline elements would delete word
  // boundaries from the rendered text.
  it("never breaks an inline run, preserving its spacing exactly", () => {
    expect(formatHtml("<p>Hello <b>there</b> friend</p>")).toBe("<p>Hello <b>there</b> friend</p>");
    expect(formatHtml("<div><p>a <a href='#'>link</a> b</p></div>")).toContain(
      "a <a href='#'>link</a> b",
    );
  });

  it("preserves placeholders", () => {
    expect(formatHtml("<p>Hi {{NAME}}</p>")).toContain("{{NAME}}");
  });

  it("is stable: formatting twice changes nothing further", () => {
    const src = "<table><tr><td style='padding:8px'><p>Hi <b>{{NAME}}</b></p></td></tr></table>";
    const once = formatHtml(src);
    expect(formatHtml(once)).toBe(once);
  });

  it("loses no text content", () => {
    const src = "<div><p>alpha</p><span>beta</span>gamma<img src='x.png'></div>";
    const text = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
    expect(text(formatHtml(src))).toBe(text(src));
  });

  it("copes with an unclosed tag rather than throwing", () => {
    expect(() => formatHtml("<div><p>oops")).not.toThrow();
  });

  it("copes with a stray closing tag", () => {
    expect(() => formatHtml("</div></div>text")).not.toThrow();
  });

  it("returns empty for empty", () => {
    expect(formatHtml("")).toBe("");
  });
});

/**
 * Reformatting is something people press repeatedly. It has to be a no-op the
 * second time, or the document drifts under them.
 */
describe("formatHtml repeated", () => {
  const withPre = `<div><pre>keep
  me</pre><p>after</p></div>`;

  it("does not grow blank lines inside a raw element", () => {
    let cur = withPre;
    const sizes: number[] = [];
    for (let n = 0; n < 4; n++) {
      cur = formatHtml(cur);
      sizes.push(cur.split("\n").length);
    }
    expect(new Set(sizes).size).toBe(1);
    expect(cur.split("\n").filter((l) => l.trim() === "")).toHaveLength(0);
  });

  it("keeps the raw element's own whitespace exactly across passes", () => {
    expect(formatHtml(formatHtml(withPre))).toContain("<pre>keep\n  me</pre>");
  });

  it("is a no-op on a realistic template after the first pass", () => {
    const src = `<table width="100%" style="background:#f6f6f4">
<tr><td align="center">
<img src="https://x/logo.png" alt="Logo" width="120">
<h2 style="margin:18px 0 8px">Invoice {{INVOICE_NO}}</h2>
<p style="margin:0 0 18px">Hello {{NAME}}, your invoice is ready.</p>
</td></tr></table>`;
    const once = formatHtml(src);
    expect(formatHtml(once)).toBe(once);
    expect(formatHtml(formatHtml(once))).toBe(once);
  });
});
