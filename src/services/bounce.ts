import { suppressions } from "../db/schema";
import type { Db } from "../db/types";

/**
 * Delivery Status Notification detection (RFC 3464).
 *
 * Cloudflare handles most bounce processing behind cf-bounce, but DSNs still
 * reach a mailbox when a recipient's server replies directly. Sending again to
 * an address that hard-bounced is what burns a domain's reputation, so those
 * are added to the suppression list automatically.
 */

export interface BounceReport {
  isBounce: boolean;
  /** true for a 5.x.x permanent failure, false for a 4.x.x transient one. */
  permanent: boolean;
  recipients: string[];
  status: string | null;
  diagnostic: string | null;
}

const NOT_A_BOUNCE: BounceReport = {
  isBounce: false,
  permanent: false,
  recipients: [],
  status: null,
  diagnostic: null,
};

/** Envelope senders used by mail systems to report delivery problems. */
function isDaemonSender(from: string): boolean {
  const local = from.toLowerCase().split("@")[0];
  return ["mailer-daemon", "postmaster", "bounce", "bounces", "no-reply-bounce"].includes(local);
}

/**
 * DSNs carry a message/delivery-status part with `Final-Recipient` and
 * `Status` fields. Parsing the raw text is more reliable than depending on how
 * a MIME library exposes nested report parts.
 */
export function detectBounce(envelopeFrom: string, rawText: string): BounceReport {
  const looksLikeReport =
    /content-type:\s*(multipart\/report|message\/delivery-status)/i.test(rawText) ||
    /report-type=delivery-status/i.test(rawText);

  if (!looksLikeReport && !isDaemonSender(envelopeFrom)) return NOT_A_BOUNCE;

  const recipients = [
    ...rawText.matchAll(/^Final-Recipient:\s*rfc822;\s*([^\s<>]+@[^\s<>]+)/gim),
    ...rawText.matchAll(/^Original-Recipient:\s*rfc822;\s*([^\s<>]+@[^\s<>]+)/gim),
  ].map((m) => m[1].trim().toLowerCase().replace(/[.,;]+$/, ""));

  const statusMatch = /^Status:\s*([245]\.\d+\.\d+)/im.exec(rawText);
  const diagnostic = /^Diagnostic-Code:\s*(.+)$/im.exec(rawText)?.[1]?.trim() ?? null;

  // An SMTP reply code in the body is a decent fallback when Status is absent.
  const smtpCode = /\b(5\d{2})[ -]\d\.\d+\.\d+\b/.exec(rawText)?.[1];

  const status = statusMatch?.[1] ?? null;
  const permanent = status ? status.startsWith("5") : Boolean(smtpCode);

  if (recipients.length === 0 && !status) return NOT_A_BOUNCE;

  return {
    isBounce: true,
    permanent,
    recipients: [...new Set(recipients)],
    status,
    diagnostic: diagnostic ? diagnostic.slice(0, 300) : null,
  };
}

/**
 * Add addresses to one org's suppression list. Shared so the row shape, the
 * lowercase normalisation and the conflict policy exist once — they had already
 * drifted between the send path, the ingest path and the manual route.
 *
 * Per org rather than global: a bounce is evidence about one sender's
 * relationship with a recipient, so one tenant hard-bouncing an address is no
 * reason to stop another mailing the same person.
 */
export async function suppress(
  db: Db,
  orgId: string,
  emails: string[],
  reason: "bounce" | "complaint" | "manual",
  detail = "",
): Promise<void> {
  const rows = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))].map(
    (email) => ({
      id: crypto.randomUUID(),
      email,
      reason,
      detail: detail.slice(0, 300),
      orgId,
      createdAt: Date.now(),
    }),
  );
  if (rows.length === 0) return;
  await db.insert(suppressions).values(rows).onConflictDoNothing();
}
