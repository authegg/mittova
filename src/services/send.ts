import type { Db } from "../db/types";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import {
  mailboxes,
  messages,
  organizations,
  suppressions,
  templates,
  attachments,
} from "../db/schema";
import { sanitiseEmailHtml, htmlToText, wrapForEmail } from "./html";
import { suppress } from "./bounce";
import { attachmentKey } from "./storage";
import { resolveThreadId } from "../email/ingest";
import { recordEvent, type WaitUntilCtx } from "./events";

export class SendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface SendInput {
  /**
   * Restrict the sending mailbox to one tenant. Omitted only by callers that
   * legitimately span tenants; every authenticated path should set it.
   */
  orgId?: string;
  /** Either a mailbox id, or a from address belonging to one of our mailboxes. */
  mailboxId?: string;
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  /**
   * Where replies should go, when that is not the sending mailbox — a no-reply
   * address pointing at a support desk, or a shared alias. Defaults to the
   * mailbox's own address.
   *
   * Not to be confused with replyToMessageId below, which is threading: this is
   * the Reply-To header, that is which message this one answers.
   */
  replyTo?: string;
  replyToMessageId?: string;
  /** Renders a stored template; `variables` fills its {{placeholders}}. */
  template?: string;
  variables?: Record<string, string>;
  attachments?: OutgoingAttachment[];
}

export interface OutgoingAttachment {
  filename: string;
  /** base64, as JSON cannot carry bytes. */
  content: string;
  type?: string;
}

/** Cloudflare caps a message at 25 MiB; stay clear of the ceiling. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function decodeBase64(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Where replies should be addressed.
 *
 * Validated but deliberately not counted against the recipient cap and not
 * checked against suppressions: nothing is delivered to this address, it only
 * tells a mail client where to aim. Falls back to the sending mailbox, which is
 * what the header said before this was configurable.
 */
export function resolveReplyTo(requested: string | undefined, mailboxAddress: string): string {
  const trimmed = requested?.trim();
  if (!trimmed) return mailboxAddress;
  if (!EMAIL_RE.test(trimmed)) {
    throw new SendError(`${trimmed} is not a valid reply-to address`, 400);
  }
  return trimmed;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Replace {{name}} with variables.name; unknown placeholders are left intact. */
function renderTemplate(source: string, variables: Record<string, string>): string {
  return source.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key: string) =>
    key in variables ? variables[key] : whole,
  );
}

export async function sendEmail(
  db: Db,
  env: Env,
  input: SendInput,
  ctx?: WaitUntilCtx,
): Promise<{ id: string; messageId: string | null; sent24h: number }> {
  /* ------------------------------------------------------------- tenant -- */

  /**
   * Establish the tenant before reading anything that belongs to one.
   *
   * The caller usually states it. When it does not — a platform administrator
   * with no org selected — it is derived from the mailbox it named, which is
   * the one thing here that is globally unique. Reading a template first and
   * reconciling afterwards looks equivalent and is not: a slug is unique only
   * within a tenant, so an unscoped lookup picks an arbitrary row among the
   * tenants that share it, and the reconciliation then rejects a send that
   * should have worked.
   */
  const named = input.mailboxId
    ? await db.select().from(mailboxes).where(eq(mailboxes.id, input.mailboxId)).get()
    : input.from
      ? await db
          .select()
          .from(mailboxes)
          .where(eq(mailboxes.address, input.from.toLowerCase()))
          .get()
      : undefined;

  const orgId = input.orgId ?? named?.orgId;
  if (!orgId) {
    throw new SendError(
      input.mailboxId || input.from
        ? `${input.from ?? input.mailboxId} is not a mailbox on this account`
        : "mailboxId or from is required",
      400,
    );
  }
  // A mailbox found without a tenant constraint has to satisfy it now.
  if (named && named.orgId !== orgId) {
    throw new SendError(`${input.from ?? input.mailboxId} is not a mailbox on this account`, 400);
  }

  /* ----------------------------------------------------------- template -- */

  // Always scoped, now that the tenant is known.
  const tpl = input.template
    ? await db
        .select()
        .from(templates)
        .where(and(eq(templates.slug, input.template), eq(templates.orgId, orgId)))
        .get()
    : undefined;
  if (input.template && !tpl) throw new SendError(`unknown template: ${input.template}`, 404);

  /* ------------------------------------------------------------ mailbox -- */

  // Either the one already resolved, or the template's default sender.
  const fromAddress = input.from ?? (tpl?.fromAddress || undefined);
  const mailbox =
    named ??
    (fromAddress
      ? await db
          .select()
          .from(mailboxes)
          .where(and(eq(mailboxes.address, fromAddress.toLowerCase()), eq(mailboxes.orgId, orgId)))
          .get()
      : undefined);

  if (!mailbox) {
    throw new SendError(
      fromAddress
        ? `${fromAddress} is not a mailbox on this account`
        : "mailboxId or from is required",
      400,
    );
  }

  /* --------------------------------------------------------- recipients -- */

  const to = input.to.map((s) => s.trim()).filter(Boolean);
  const cc = (input.cc ?? []).map((s) => s.trim()).filter(Boolean);
  const bcc = (input.bcc ?? []).map((s) => s.trim()).filter(Boolean);

  if (to.length === 0) throw new SendError("at least one recipient is required", 400);

  const invalid = [...to, ...cc, ...bcc].find((a) => !EMAIL_RE.test(a));
  if (invalid) throw new SendError(`${invalid} is not a valid email address`, 400);

  // Most specific wins: this send, then the template's default, then the
  // mailbox's standing one, then the mailbox itself. Only the per-send value is
  // re-validated; the stored ones were checked when they were saved, and a bad
  // stored value must not be able to block sending.
  const replyTo = resolveReplyTo(input.replyTo, tpl?.replyTo || mailbox.replyTo || mailbox.address);

  if (to.length + cc.length + bcc.length > 50) {
    throw new SendError("a message can address at most 50 recipients", 400);
  }

  // Suppressed addresses are hard-blocked; sending to a known bounce or
  // complaint is what burns a domain's reputation.
  const all = [...to, ...cc, ...bcc].map((a) => a.toLowerCase());
  const blocked = await db
    .select()
    .from(suppressions)
    .where(and(inArray(suppressions.email, all), eq(suppressions.orgId, mailbox.orgId)))
    .all();
  if (blocked.length > 0) {
    throw new SendError(
      `suppressed recipient: ${blocked.map((b) => b.email).join(", ")}`,
      403,
      "E_RECIPIENT_SUPPRESSED",
      { suppressed: blocked.map((b) => ({ email: b.email, reason: b.reason })) },
    );
  }

  /* ------------------------------------------------------------- quota --- */

  const since = Date.now() - 24 * 60 * 60 * 1000;
  const [quota] = await db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(
      and(
        eq(messages.mailboxId, mailbox.id),
        eq(messages.direction, "out"),
        gt(messages.createdAt, since),
      ),
    )
    .all();
  const sent24h = Number(quota?.count ?? 0);

  if (sent24h >= mailbox.dailySendLimit) {
    throw new SendError(
      `daily send limit reached for ${mailbox.address} (${mailbox.dailySendLimit}/24h)`,
      429,
      "E_DAILY_LIMIT_EXCEEDED",
      { sent24h, limit: mailbox.dailySendLimit },
    );
  }

  /**
   * The tenant's own ceiling, on top of the mailbox's.
   *
   * A per-mailbox cap bounds one address; a client with twenty mailboxes could
   * still spend the whole deployment's sending reputation, which every other
   * tenant then pays for. Zero means unlimited, which is the default and what
   * every existing org has.
   */
  const org = await db
    .select({ limit: organizations.dailySendLimit, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .get();

  if (org && org.limit > 0) {
    const [orgQuota] = await db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .innerJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
      .where(
        and(
          eq(mailboxes.orgId, orgId),
          eq(messages.direction, "out"),
          gt(messages.createdAt, Date.now() - 24 * 60 * 60 * 1000),
        ),
      )
      .all();
    const orgSent = Number(orgQuota?.count ?? 0);
    if (orgSent >= org.limit) {
      throw new SendError(
        `daily send limit reached for ${org.name} (${org.limit}/24h)`,
        429,
        "E_ORG_LIMIT_EXCEEDED",
        { sent24h: orgSent, limit: org.limit },
      );
    }
  }

  /* ---------------------------------------------------------- content ---- */

  let subject = input.subject;
  let text = input.text;
  let html = input.html;

  // A template is an authored layout; composed HTML is prose from a composer.
  // They need different treatment downstream, so remember which this is.
  let htmlIsLayout = false;

  if (tpl) {
    const vars = input.variables ?? {};
    subject = subject ?? renderTemplate(tpl.subject, vars);
    text = text ?? renderTemplate(tpl.bodyText, vars);
    if (html === undefined && tpl.bodyHtml) {
      html = renderTemplate(tpl.bodyHtml, vars);
      htmlIsLayout = true;
    }
  }

  if (!text && !html) throw new SendError("text, html, or template is required", 400);

  /* --------------------------------------------------------- threading --- */

  const original = input.replyToMessageId
    ? await db.select().from(messages).where(eq(messages.id, input.replyToMessageId)).get()
    : undefined;

  if (input.replyToMessageId && !original) {
    throw new SendError(`unknown replyToMessageId: ${input.replyToMessageId}`, 404);
  }

  const headers: Record<string, string> = {};
  if (original?.rfcMessageId) {
    headers["In-Reply-To"] = original.rfcMessageId;
    headers["References"] = [original.msgReferences, original.rfcMessageId]
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  const finalSubject = subject?.trim() || (original ? `Re: ${original.subject}` : "(no subject)");

  // Never trust submitted HTML, even from an authenticated session: this mail
  // goes out DKIM-signed by our domain.
  // A template already carries its own typography and structure, so it is not
  // wrapped: the wrapper exists to supply what composed prose lacks, and
  // imposing it on a layout would fight the layout.
  const finalHtml = htmlIsLayout
    ? sanitiseEmailHtml(html!, { layout: true })
    : wrapForEmail(
        html ? sanitiseEmailHtml(html) : `<p>${escapeHtml(text!).replace(/\n/g, "<br>")}</p>`,
      );
  const finalText = text ?? htmlToText(finalHtml);

  /* ------------------------------------------------------------- send ---- */

  const id = crypto.randomUUID();
  let rfcMessageId: string | null = null;

  const outgoing = (input.attachments ?? []).map((a) => {
    const bytes = decodeBase64(a.content);
    return {
      filename: a.filename,
      type: a.type || "application/octet-stream",
      bytes,
    };
  });
  const totalBytes = outgoing.reduce((n, a) => n + a.bytes.byteLength, 0);
  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    throw new SendError(
      `attachments total ${(totalBytes / 1024 / 1024).toFixed(1)} MB, limit is 20 MB`,
      413,
      "E_CONTENT_TOO_LARGE",
    );
  }

  try {
    const result = await env.EMAIL.send({
      to,
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
      from: { email: mailbox.address, name: mailbox.name },
      replyTo,
      subject: finalSubject,
      text: finalText,
      html: finalHtml,
      headers: Object.keys(headers).length ? headers : undefined,
      attachments: outgoing.length
        ? outgoing.map((a) => ({
            // The binding wants an ArrayBuffer for binary content.
            content: a.bytes.buffer.slice(
              a.bytes.byteOffset,
              a.bytes.byteOffset + a.bytes.byteLength,
            ) as ArrayBuffer,
            filename: a.filename,
            type: a.type,
            disposition: "attachment" as const,
          }))
        : undefined,
    });
    rfcMessageId = result?.messageId ?? null;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error("EMAIL.send failed", e.code, e.message);

    // Cloudflare telling us the address is suppressed is authoritative — record
    // it so the next attempt is blocked before it ever reaches the wire.
    if (e.code === "E_RECIPIENT_SUPPRESSED") {
      await suppress(
        db,
        mailbox.orgId,
        to,
        "bounce",
        e.message ?? "suppressed by Cloudflare Email Service",
      );
    }

    throw new SendError(e.message ?? "send failed", 502, e.code ?? null);
  }

  /* ------------------------------------------------------------ record --- */

  await db.insert(messages).values({
    id,
    mailboxId: mailbox.id,
    direction: "out",
    threadId: original?.threadId ?? resolveThreadId(null, null, rfcMessageId ?? id),
    rfcMessageId,
    inReplyTo: original?.rfcMessageId ?? null,
    msgReferences: headers["References"] ?? null,
    fromAddr: mailbox.address,
    fromName: mailbox.name,
    toAddr: to.join(", "),
    ccAddr: cc.length ? cc.join(", ") : null,
    subject: finalSubject,
    snippet: finalText.replace(/\s+/g, " ").trim().slice(0, 200),
    bodyText: finalText,
    bodyHtml: finalHtml,
    size: finalText.length + finalHtml.length + totalBytes,
    seen: 1,
    createdAt: Date.now(),
  });

  for (const a of outgoing) {
    const attId = crypto.randomUUID();
    const key = attachmentKey(mailbox.address, id, attId);
    await env.STORAGE.put(key, a.bytes, { httpMetadata: { contentType: a.type } });
    await db.insert(attachments).values({
      id: attId,
      messageId: id,
      filename: a.filename,
      mimeType: a.type,
      size: a.bytes.byteLength,
      contentId: null,
      r2Key: key,
    });
  }

  await recordEvent(db, env, {
    messageId: id,
    orgId: mailbox.orgId,
    type: "email.sent",
    detail: `accepted by Cloudflare Email Service as ${rfcMessageId ?? "unknown id"}`,
    payload: {
      id,
      messageId: rfcMessageId,
      from: mailbox.address,
      to,
      cc,
      subject: finalSubject,
    },
    ctx,
  });

  return { id, messageId: rfcMessageId, sent24h: sent24h + 1 };
}
