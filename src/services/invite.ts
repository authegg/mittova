import { and, eq, inArray } from "drizzle-orm";
import { mailboxes, organizations } from "../db/schema";
import type { Db } from "../db/types";
import { isDemo } from "./demo-mode";
import { wrapForEmail } from "./html";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * Email an invite link, from one of the account's own organization's mailboxes:
 * one it is being given if there is one, so the sender is an address the person
 * will recognise.
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

  const inOrg = eq(mailboxes.orgId, invite.orgId);
  const mailbox =
    (invite.preferMailboxIds.length
      ? await db
          .select()
          .from(mailboxes)
          .where(and(inOrg, inArray(mailboxes.id, invite.preferMailboxIds)))
          .get()
      : undefined) ?? (await db.select().from(mailboxes).where(inOrg).get());
  if (!mailbox) return { error: "This organization has no mailbox to send from." };

  const org = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, invite.orgId))
    .get();
  const where = org?.name ?? env.APP_NAME;
  const text = [
    `Hi ${invite.name},`,
    "",
    `You have been given an account on ${where}'s ${env.APP_NAME} mail. Choose your password here:`,
    "",
    invite.url,
    "",
    "The link works once and expires in seven days. If you were not expecting this, ignore it.",
  ].join("\n");
  const html = wrapForEmail(
    text
      .split("\n\n")
      .map((p) =>
        p === invite.url
          ? `<p><a href="${escapeHtml(p)}">Choose your password</a></p>`
          : `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`,
      )
      .join(""),
  );

  try {
    await env.EMAIL.send({
      to: invite.to,
      from: { email: mailbox.address, name: mailbox.name },
      subject: `Your ${where} mail account`,
      text,
      html,
    });
    return { from: mailbox.address };
  } catch (err) {
    console.error("invite send failed", (err as Error).message);
    return { error: (err as Error).message || "The invite could not be sent." };
  }
}
