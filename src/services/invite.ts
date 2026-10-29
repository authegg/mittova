import { and, eq, inArray } from "drizzle-orm";
import { mailboxes, organizations, templates } from "../db/schema";
import type { Db } from "../db/types";
import { isDemo } from "./demo-mode";
import { htmlToText, sanitiseEmailHtml } from "./html";
import { renderTemplate } from "./send";

/** An org overrides the invite email by keeping a template with this slug. */
export const INVITE_SLUG = "user-invite";

/**
 * The invite email every org gets until it keeps its own `user-invite`
 * template, and the starting point when it does.
 *
 * No raw link in the HTML: the sanitiser drops word-break, so a 90-character
 * URL widens the card past a phone screen. The plain-text part carries it.
 */
export const INVITE_STARTER = {
  slug: INVITE_SLUG,
  name: "User invite",
  subject: "Your {{org}} mail account",
  bodyText: [
    "Hi {{name}},",
    "",
    "{{org}} has set up a mail account for you. Choose your password to sign in:",
    "",
    "{{link}}",
    "",
    "The link works once and expires in seven days. If you were not expecting this, you can ignore it.",
  ].join("\n"),
  bodyHtml: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2;padding:32px 16px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e4e4e0;border-radius:8px;">
        <tr>
          <td style="padding:32px 32px 8px;">
            <p style="margin:0 0 24px;font-size:13px;color:#6b6a66;letter-spacing:0.02em;">{{org}}</p>
            <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#1a1917;font-weight:600;">You have a new mail account</h1>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#3a3936;">Hi {{name}}, {{org}} has set up a mailbox for you. Choose your password to sign in as <strong>{{email}}</strong>.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 32px 24px;">
            <a href="{{link}}" style="display:inline-block;background:#1a1917;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:6px;">Choose your password</a>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 32px;">
            <p style="margin:0;font-size:13px;line-height:1.6;color:#6b6a66;">The link works once and expires in seven days.</p>
          </td>
        </tr>
      </table>
      <p style="margin:16px 0 0;font-size:12px;color:#8a8984;">Not expecting this? You can ignore it; nothing happens until the link is used.</p>
    </td>
  </tr>
</table>`,
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * Email an invite link, rendered from the org's `user-invite` template or the
 * built-in one, and sent from the template's sender if it names one, else a
 * mailbox the account is being given, else any of the org's own.
 *
 * Sent straight through the binding rather than sendEmail, so no copy lands in
 * that mailbox's Sent folder. The link is a credential until it is used, and
 * everyone else with access to that mailbox could otherwise read it and set the
 * new account's password themselves.
 *
 * Never throws: the caller still has the link to hand over by other means.
 */
export async function mailInvite(
  db: Db,
  env: Env,
  invite: { orgId: string; preferMailboxIds: string[]; to: string; name: string; url: string },
): Promise<{ from: string } | { error: string }> {
  if (isDemo(env)) return { error: "Sending is disabled on the demo." };

  const custom = await db
    .select()
    .from(templates)
    .where(and(eq(templates.orgId, invite.orgId), eq(templates.slug, INVITE_SLUG)))
    .get();
  const tpl = custom ?? INVITE_STARTER;

  const inOrg = eq(mailboxes.orgId, invite.orgId);
  const pick = (where: ReturnType<typeof and>) =>
    db.select().from(mailboxes).where(and(inOrg, where)).get();
  const mailbox =
    (custom?.fromAddress ? await pick(eq(mailboxes.address, custom.fromAddress)) : undefined) ??
    (invite.preferMailboxIds.length
      ? await pick(inArray(mailboxes.id, invite.preferMailboxIds))
      : undefined) ??
    (await pick(undefined));
  if (!mailbox) return { error: "This organization has no mailbox to send from." };

  const org = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, invite.orgId))
    .get();
  const vars = {
    name: invite.name,
    email: invite.to,
    org: org?.name ?? env.APP_NAME,
    link: invite.url,
  };
  const htmlVars = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, escapeHtml(v)]));
  // Gmail turns anything shaped like a domain or an address into a blue link,
  // so "clodous.com" read as a link to a website. A zero-width non-joiner before
  // each . and @ is invisible and breaks the match. The link is left alone.
  for (const k of ["org", "email"]) htmlVars[k] = htmlVars[k].replace(/[.@]/g, "\u200c$&");
  const html = tpl.bodyHtml
    ? sanitiseEmailHtml(renderTemplate(tpl.bodyHtml, htmlVars), { layout: true })
    : undefined;
  const text = tpl.bodyText ? renderTemplate(tpl.bodyText, vars) : htmlToText(html ?? "");

  try {
    await env.EMAIL.send({
      to: invite.to,
      from: { email: mailbox.address, name: mailbox.name },
      subject: renderTemplate(tpl.subject, vars) || `Your ${vars.org} mail account`,
      text,
      html,
    });
    return { from: mailbox.address };
  } catch (err) {
    console.error("invite send failed", (err as Error).message);
    return { error: (err as Error).message || "The invite could not be sent." };
  }
}
