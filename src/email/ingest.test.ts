import { describe, expect, it } from "vitest";
import { resolveThreadId } from "./ingest";

/**
 * Threading decides whether a reply lands in the same conversation in the
 * recipient's client, so the RFC 2822 precedence is asserted explicitly.
 */
describe("resolveThreadId", () => {
  const own = "<own@mittova>";

  it("prefers the head of References", () => {
    expect(resolveThreadId("<root@a> <mid@b>", "<mid@b>", own)).toBe("<root@a>");
  });

  it("falls back to In-Reply-To when there is no References", () => {
    expect(resolveThreadId(null, "<parent@a>", own)).toBe("<parent@a>");
  });

  it("starts a new thread when the message references nothing", () => {
    expect(resolveThreadId(null, null, own)).toBe(own);
  });

  it("ignores headers that contain no message id", () => {
    expect(resolveThreadId("   ", "not-an-id", own)).toBe(own);
  });

  it("copes with folded and comma separated References", () => {
    expect(resolveThreadId("\r\n <root@a>,\r\n <mid@b>", null, own)).toBe("<root@a>");
  });

  it("keeps the whole thread on one id across a chain", () => {
    const root = resolveThreadId(null, null, "<a@x>");
    const reply = resolveThreadId("<a@x>", "<a@x>", "<b@x>");
    const replyToReply = resolveThreadId("<a@x> <b@x>", "<b@x>", "<c@x>");
    expect(new Set([root, reply, replyToReply]).size).toBe(1);
  });
});
