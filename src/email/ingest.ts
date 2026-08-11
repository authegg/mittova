import PostalMime from "postal-mime";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { mailboxes, messages, attachments } from "../db/schema";
import { detectBounce, suppress } from "../services/bounce";
import { recordEvent, type WaitUntilCtx } from "../services/events";
import { attachmentKey, rawKey as buildRawKey } from "../services/storage";

/** Pull the first angle-bracketed id out of a References/In-Reply-To header. */
function firstMessageId(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = header.match(/<[^>]+>/);
  return match ? match[0] : null;
}

/**
 * Root of the conversation, per RFC 2822: the head of References if the client
 * sent one, else whatever we're replying to, else this message starts a thread.
 */
export function resolveThreadId(
  references: string | null,
  inReplyTo: string | null,
  ownId: string,
): string {
  return firstMessageId(references) ?? firstMessageId(inReplyTo) ?? ownId;
}

/** `spf=pass dkim=fail ...` out of the Authentication-Results header. */
function authVerdict(authResults: string | null, mechanism: string): string | null {
  if (!authResults) return null;
  const match = authResults.match(new RegExp(`\\b${mechanism}=(\\w+)`, "i"));
  return match ? match[1].toLowerCase() : null;
}

function snippetOf(text: string | undefined, html: string | undefined): string {
  const source = text ?? (html ? html.replace(/<[^>]*>/g, " ") : "");
  return source.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Store one inbound message: raw MIME to R2, structured fields to D1,
 * attachments to R2 with metadata rows.
 */
export async function ingestEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx?: WaitUntilCtx,
): Promise<void> {
  const db = drizzle(env.DB);
  const recipient = message.to.toLowerCase();

  const mailbox = await db
    .select()
    .from(mailboxes)
    .where(eq(mailboxes.address, recipient))
    .get();

  if (!mailbox) {
    // Routing rules should prevent this, but never silently swallow mail.
    message.setReject(`550 5.1.1 No such mailbox: ${recipient}`);
    return;
  }

  // message.raw is a single-use stream — buffer before anything else touches it.
  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const parsed = await PostalMime.parse(rawBuffer);

  const id = crypto.randomUUID();
  const rawKey = buildRawKey(mailbox.address, mailbox.id, id);
  await env.STORAGE.put(rawKey, rawBuffer, {
    httpMetadata: { contentType: "message/rfc822" },
  });

  const headers = message.headers;
  const rfcMessageId = parsed.messageId ?? headers.get("message-id");
  const inReplyTo = parsed.inReplyTo ?? headers.get("in-reply-to");
  const references = parsed.references ?? headers.get("references");
  const authResults = headers.get("authentication-results");

  await db.insert(messages).values({
    id,
    mailboxId: mailbox.id,
    direction: "in",
    threadId: resolveThreadId(references ?? null, inReplyTo ?? null, rfcMessageId ?? id),
    rfcMessageId: rfcMessageId ?? null,
    inReplyTo: inReplyTo ?? null,
    msgReferences: references ?? null,
    fromAddr: message.from.toLowerCase(),
    fromName: parsed.from?.name ?? "",
    toAddr: recipient,
    ccAddr: parsed.cc?.map((a) => a.address).filter(Boolean).join(", ") || null,
    subject: parsed.subject ?? "(no subject)",
    snippet: snippetOf(parsed.text, parsed.html),
    bodyText: parsed.text ?? null,
    bodyHtml: parsed.html ?? null,
    spf: authVerdict(authResults, "spf"),
    dkim: authVerdict(authResults, "dkim"),
    dmarc: authVerdict(authResults, "dmarc"),
    rawKey,
    size: message.rawSize,
    seen: 0,
    createdAt: Date.now(),
  });

  // A delivery failure report means the recipient is undeliverable; sending
  // there again is what damages sender reputation.
  // Gate on the two cheap signals first. Decoding 64 KB and running report
  // regexes over it on every ordinary message is real cost on the ingest path,
  // and a bounce is the rare case.
  const contentType = headers.get("content-type") ?? "";
  const maybeBounce =
    /multipart\/report|delivery-status/i.test(contentType) ||
    ["mailer-daemon", "postmaster", "bounce", "bounces"].includes(
      message.from.toLowerCase().split("@")[0],
    );

  const bounce = maybeBounce
    ? detectBounce(message.from, new TextDecoder().decode(new Uint8Array(rawBuffer, 0, Math.min(rawBuffer.byteLength, 16 * 1024))))
    : { isBounce: false, permanent: false, recipients: [] as string[], status: null, diagnostic: null };

  if (bounce.isBounce && bounce.permanent && bounce.recipients.length > 0) {
    // Suppressed for the tenant that owns the mailbox the report came back to,
    // which is the tenant whose reputation the failure belongs to.
    await suppress(
      db,
      mailbox.orgId,
      bounce.recipients,
      "bounce",
      [bounce.status, bounce.diagnostic].filter(Boolean).join(" — "),
    );
  }

  await recordEvent(db, env, {
    messageId: id,
    orgId: mailbox.orgId,
    type: bounce.isBounce ? "email.bounced" : "email.received",
    detail: bounce.isBounce
      ? `${bounce.permanent ? "hard" : "soft"} bounce for ${bounce.recipients.join(", ") || "unknown recipient"}` +
        (bounce.status ? ` (${bounce.status})` : "")
      : `from ${message.from} (${message.rawSize} bytes)`,
    payload: {
      id,
      messageId: rfcMessageId,
      from: message.from.toLowerCase(),
      to: recipient,
      subject: parsed.subject ?? "(no subject)",
      spf: authVerdict(authResults, "spf"),
      dkim: authVerdict(authResults, "dkim"),
      dmarc: authVerdict(authResults, "dmarc"),
      bounce: bounce.isBounce ? bounce : undefined,
    },
    ctx,
  });

  for (const att of parsed.attachments ?? []) {
    const attId = crypto.randomUUID();
    const filename = att.filename ?? `attachment-${attId}`;
    const key = attachmentKey(mailbox.address, id, attId);
    const body = att.content instanceof ArrayBuffer ? att.content : new TextEncoder().encode(String(att.content));
    await env.STORAGE.put(key, body, {
      httpMetadata: { contentType: att.mimeType ?? "application/octet-stream" },
    });
    await db.insert(attachments).values({
      id: attId,
      messageId: id,
      filename,
      mimeType: att.mimeType ?? "application/octet-stream",
      size: body.byteLength,
      contentId: att.contentId ?? null,
      r2Key: key,
    });
  }
}
