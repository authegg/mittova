import { describe, expect, it } from "vitest";
import { sanitiseEmailHtml } from "./html";

/**
 * safeHref strips control characters before matching the scheme, because a
 * newline or tab inserted into "javascript:" is a real bypass — the browser
 * ignores them, a naive prefix check does not.
 *
 * The character class was written with literal control bytes rather than
 * escapes, which made the whole file read as binary to grep and diff. These
 * pin the behaviour so the fix cannot have changed it.
 */
describe("safeHref control-character stripping", () => {
  const SCHEME = "javascript:alert(1)";
  const INSERTED = ["\x00", "\x01", "\t", "\n", "\r", "\x0b", "\x1f", "\x7f", " "];

  it("blocks javascript: however it is broken up", () => {
    for (const c of INSERTED) {
      // Between "java" and "script:", where a browser would still run it.
      const url = `java${c}${SCHEME.slice(4)}`;
      const out = sanitiseEmailHtml(`<a href="${url}">x</a>`);
      expect(out, `let through 0x${c.charCodeAt(0).toString(16)}`).not.toContain("href");
    }
  });

  it("blocks it plain, and whatever the casing", () => {
    expect(sanitiseEmailHtml(`<a href="${SCHEME}">x</a>`)).not.toContain("href");
    expect(sanitiseEmailHtml(`<a href="JaVaScRiPt:alert(1)">x</a>`)).not.toContain("href");
  });

  it("blocks data: URLs, which are their own way in", () => {
    expect(sanitiseEmailHtml(`<a href="data:text/html,<script>x</script>">x</a>`)).not.toContain(
      "href",
    );
  });

  it("still keeps ordinary links", () => {
    expect(sanitiseEmailHtml(`<a href="https://example.com">ok</a>`)).toContain(
      'href="https://example.com"',
    );
    expect(sanitiseEmailHtml(`<a href="http://example.com">ok</a>`)).toContain(
      "http://example.com",
    );
    expect(sanitiseEmailHtml(`<a href="mailto:a@b.com">ok</a>`)).toContain("mailto:a@b.com");
  });

  /**
   * The allowlist is what refuses "java\x00script:", not the stripping — the
   * scheme simply is not http, https or mailto. What the stripping decides is
   * what gets *emitted*, and the function used to validate a cleaned copy while
   * returning the original, so a control byte survived into the attribute.
   */
  it("emits the string it validated, not the raw one", () => {
    const out = sanitiseEmailHtml(`<a href="\x00https://example.com">x</a>`);
    expect(out).toContain('href="https://example.com"');
    expect(out).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it("cleans a wrapped URL rather than refusing it", () => {
    // Mail wraps long URLs, so a real CR/LF inside an href is ordinary.
    const out = sanitiseEmailHtml(`<a href="https://example.com/a\r\n/b">x</a>`);
    expect(out).toContain('href="https://example.com/a/b"');
  });

  it("applies the same rule to an image source", () => {
    const out = sanitiseEmailHtml(`<img src="\x01https://example.com/l.png">`, { layout: true });
    expect(out).toContain('src="https://example.com/l.png"');
    expect(out).not.toMatch(/[\x00-\x1f\x7f]/);
  });
});
