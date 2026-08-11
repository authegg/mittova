import { describe, expect, it } from "vitest";
import { highlight } from "./CodeEditor";

/**
 * The highlighter's output is assigned to innerHTML in the dashboard's own
 * origin, and its input is template source an org owner controls. Escaping is
 * the only thing between the two, so these test the invariant rather than the
 * colours: no caller-supplied `<` may survive as markup.
 */
describe("highlight escaping", () => {
  const liveTag = /<(?!\/?span\b)[a-zA-Z!/]/;

  it("emits no element other than its own spans", () => {
    const payloads = [
      // Escaping only the regex's matches left the rest verbatim, so a second
      // `<` inside a tag opened a real element in the dashboard.
      `<p <style>*{position:fixed;inset:0;background:url(https://evil/x)}`,
      `<p </style><style>body{display:none}`,
      `<img src=x onerror=alert(1)>`,
      `<p <script>alert(1)</script>`,
      `<div title="<script>alert(1)</script>">`,
      `<!-- <style>x</style> -->`,
      `plain text with <angle> brackets & ampersands`,
      `<p attr=<b>unquoted>`,
    ];
    for (const p of payloads) {
      const out = highlight(p);
      expect(out, `leaked markup for: ${p}`).not.toMatch(liveTag);
    }
  });

  it("escapes every angle bracket and ampersand it was given", () => {
    // Prose outside any tag passes straight through, escaped.
    expect(highlight("a & b")).toBe("a &amp; b");
    // `< c >` looks enough like a tag to be tokenised, which is fine as long as
    // the brackets are escaped inside the spans rather than emitted as markup.
    const out = highlight("a & b < c > d");
    expect(out).not.toMatch(liveTag);
    expect(out).toContain("&amp;");
    expect(out).toContain("&lt;");
  });

  it("still colours what it is for", () => {
    const out = highlight(`<td style="padding:8px">Hi {{NAME}}</td>`);
    expect(out).toContain('class="tok-tag"');
    expect(out).toContain('class="tok-attr"');
    expect(out).toContain('class="tok-string"');
    expect(out).toContain('class="tok-var"');
  });

  it("keeps the text intact once tags are stripped", () => {
    const src = `<p class="a">Hello {{NAME}} & welcome</p>`;
    const text = (s: string) => s.replace(/<[^>]*>/g, "");
    expect(text(highlight(src))).toContain("Hello ");
    expect(text(highlight(src))).toContain("welcome");
  });
});
