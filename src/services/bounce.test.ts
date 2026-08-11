import { describe, expect, it } from "vitest";
import { detectBounce } from "./bounce";

const HARD_BOUNCE = `Return-Path: <>
From: MAILER-DAEMON@mx.example.net
Subject: Undelivered Mail Returned to Sender
Content-Type: multipart/report; report-type=delivery-status; boundary="B1"

--B1
Content-Type: message/delivery-status

Reporting-MTA: dns; mx.example.net
Final-Recipient: rfc822; nobody@example.com
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 <nobody@example.com>: Recipient address rejected
--B1--`;

const SOFT_BOUNCE = `From: postmaster@mx.example.net
Content-Type: multipart/report; report-type=delivery-status; boundary="B2"

--B2
Content-Type: message/delivery-status

Final-Recipient: rfc822; busy@example.com
Action: delayed
Status: 4.2.2
Diagnostic-Code: smtp; 452 4.2.2 Mailbox full
--B2--`;

describe("detectBounce", () => {
  it("recognises a hard bounce and extracts the recipient", () => {
    const r = detectBounce("MAILER-DAEMON@mx.example.net", HARD_BOUNCE);
    expect(r.isBounce).toBe(true);
    expect(r.permanent).toBe(true);
    expect(r.recipients).toEqual(["nobody@example.com"]);
    expect(r.status).toBe("5.1.1");
    expect(r.diagnostic).toContain("Recipient address rejected");
  });

  it("treats a 4.x.x report as transient, so it is not suppressed", () => {
    const r = detectBounce("postmaster@mx.example.net", SOFT_BOUNCE);
    expect(r.isBounce).toBe(true);
    expect(r.permanent).toBe(false);
    expect(r.recipients).toEqual(["busy@example.com"]);
  });

  it("leaves ordinary mail alone", () => {
    const r = detectBounce("customer@example.com", "From: customer@example.com\nSubject: Question\n\nWhen does it ship?");
    expect(r.isBounce).toBe(false);
    expect(r.recipients).toEqual([]);
  });

  it("does not flag a human message merely because a daemon relayed it", () => {
    const r = detectBounce("customer@example.com", "Subject: hi\n\nplain body");
    expect(r.isBounce).toBe(false);
  });

  it("deduplicates recipients reported twice", () => {
    const raw = HARD_BOUNCE.replace(
      "Final-Recipient: rfc822; nobody@example.com",
      "Original-Recipient: rfc822; nobody@example.com\nFinal-Recipient: rfc822; nobody@example.com",
    );
    expect(detectBounce("MAILER-DAEMON@x", raw).recipients).toEqual(["nobody@example.com"]);
  });

  it("falls back to an SMTP code when Status is absent", () => {
    const raw = `From: mailer-daemon@x\nContent-Type: multipart/report; report-type=delivery-status\n\nFinal-Recipient: rfc822; gone@example.com\n550 5.1.1 user unknown`;
    const r = detectBounce("mailer-daemon@x", raw);
    expect(r.isBounce).toBe(true);
    expect(r.permanent).toBe(true);
  });

  it("strips trailing punctuation from addresses", () => {
    const raw = `Content-Type: message/delivery-status\n\nFinal-Recipient: rfc822; a@b.com.\nStatus: 5.0.0`;
    expect(detectBounce("mailer-daemon@x", raw).recipients).toEqual(["a@b.com"]);
  });

  it("never throws on truncated or empty reports", () => {
    for (const raw of ["", "Content-Type: multipart/report", "Status:", "Final-Recipient:"]) {
      expect(() => detectBounce("mailer-daemon@x", raw)).not.toThrow();
    }
  });
});
