import { describe, expect, it } from "vitest";
import { resolveReplyTo, SendError } from "./send";

/**
 * Reply-To decides where a human's reply is addressed, so getting it wrong
 * sends the answer somewhere nobody reads. The default matters as much as the
 * override: omitting it must keep the previous behaviour of replying to the
 * sending mailbox.
 */
describe("resolveReplyTo", () => {
  const mailbox = "support@example.com";

  it("falls back to the sending mailbox when none is given", () => {
    expect(resolveReplyTo(undefined, mailbox)).toBe(mailbox);
  });

  it("treats empty and whitespace-only as not given", () => {
    expect(resolveReplyTo("", mailbox)).toBe(mailbox);
    expect(resolveReplyTo("   ", mailbox)).toBe(mailbox);
  });

  it("uses the requested address", () => {
    expect(resolveReplyTo("desk@other.com", mailbox)).toBe("desk@other.com");
  });

  it("trims surrounding whitespace", () => {
    expect(resolveReplyTo("  desk@other.com \n", mailbox)).toBe("desk@other.com");
  });

  // A domain other than the sender's is the whole point: a no-reply address
  // that routes answers to a support desk elsewhere.
  it("allows a different domain from the sending mailbox", () => {
    expect(resolveReplyTo("help@somewhere-else.org", mailbox)).toBe("help@somewhere-else.org");
  });

  it("rejects a malformed address rather than putting it on the wire", () => {
    for (const bad of ["not-an-address", "no@tld", "two@@at.com", "spaces in@x.com", "@x.com"]) {
      expect(() => resolveReplyTo(bad, mailbox)).toThrow(SendError);
    }
  });

  it("reports a bad address as a 400 naming the value", () => {
    try {
      resolveReplyTo("nope", mailbox);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SendError);
      expect((err as SendError).status).toBe(400);
      expect((err as SendError).message).toContain("nope");
    }
  });
});
