/**
 * Fill the local database with demo content, so `npm run dev` shows a dashboard
 * with something in it.
 *
 * Everything here is fabricated. The domains sit under .example, a reserved TLD
 * that can never be registered, so nothing can accidentally address a real
 * mailbox. Password and API key hashes are placeholders that correspond to no
 * credential: none of these accounts can be signed into, and none of the keys
 * has ever existed. Sign in with the ADMIN_PASSWORD from .dev.vars instead, by
 * leaving the email field empty.
 *
 * Local only. It refuses to touch a remote database, and it deletes before it
 * inserts, so never point it at anything you care about.
 *
 *   npm run seed:demo
 */

import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { c, root, wrangler } from "./lib.mjs";

const DB = "mittova-mail";

// Relative to now, in whole seconds, so the dashboard shows plausible ages
// rather than a wall of identical timestamps.
const ago = (seconds) => `(strftime('%s','now') - ${seconds}) * 1000`;

const SQL = `
DELETE FROM messages;
DELETE FROM user_mailboxes;
DELETE FROM api_keys;
DELETE FROM templates;
DELETE FROM users;
DELETE FROM mailboxes;
DELETE FROM domains;
DELETE FROM organizations;

INSERT INTO organizations (id, name, slug, created_at, daily_send_limit) VALUES
  ('org_demo', 'Northwind Supply', 'northwind', ${ago(5184000)}, 2000),
  ('org_two', 'Harbourline Freight', 'harbourline', ${ago(2592000)}, 500);

INSERT INTO domains (id, domain, zone_id, created_at, org_id) VALUES
  ('dom_demo', 'northwind.example', '', ${ago(5184000)}, 'org_demo');

INSERT INTO mailboxes (id, address, name, daily_send_limit, created_at, org_id, reply_to) VALUES
  ('mb_hello',   'hello@northwind.example',   'Hello',   500, ${ago(5184000)}, 'org_demo', ''),
  ('mb_support', 'support@northwind.example', 'Support', 500, ${ago(5184000)}, 'org_demo', ''),
  ('mb_billing', 'billing@northwind.example', 'Billing', 200, ${ago(5184000)}, 'org_demo', '');

INSERT INTO users (id, email, name, role, password_hash, password_salt, password_iterations,
                   must_change_password, disabled, signature, last_login_at, created_at, org_id) VALUES
  ('usr_1', 'imogen@northwind.example', 'Imogen Clarke', 'owner',  'unusable', 'unusable', 200000, 0, 0, '', ${ago(3600)},   ${ago(5184000)}, 'org_demo'),
  ('usr_2', 'ravi@northwind.example',   'Ravi Menon',    'member', 'unusable', 'unusable', 200000, 0, 0, '', ${ago(86400)},  ${ago(4320000)}, 'org_demo'),
  ('usr_3', 'sofia@northwind.example',  'Sofia Almeida', 'member', 'unusable', 'unusable', 200000, 0, 0, '', ${ago(259200)}, ${ago(2592000)}, 'org_demo'),
  ('usr_4', 'ops@harbourline.example',  'Tomas Berg',    'owner',  'unusable', 'unusable', 200000, 0, 0, '', ${ago(7200)},   ${ago(2592000)}, 'org_two');

INSERT INTO user_mailboxes (user_id, mailbox_id, created_at) VALUES
  ('usr_1', 'mb_hello',   ${ago(5184000)}),
  ('usr_1', 'mb_support', ${ago(5184000)}),
  ('usr_1', 'mb_billing', ${ago(5184000)}),
  ('usr_2', 'mb_support', ${ago(4320000)}),
  ('usr_3', 'mb_support', ${ago(2592000)}),
  ('usr_3', 'mb_hello',   ${ago(2592000)});

INSERT INTO templates (id, slug, name, subject, body_text, body_html, updated_at, created_at, org_id, from_address, reply_to) VALUES
  ('tpl_1', 'order-confirmation', 'Order confirmation', 'Your order {{order_id}} is confirmed',
   'Thanks for your order. We will let you know when it ships.',
   '<table width="100%"><tr><td><h1>Order {{order_id}} confirmed</h1><p>Thanks for your order. We will let you know when it ships.</p></td></tr></table>',
   ${ago(172800)}, ${ago(4320000)}, 'org_demo', 'hello@northwind.example', ''),
  ('tpl_2', 'dispatch-notice', 'Dispatch notice', 'Order {{order_id}} is on its way',
   'Your order left the warehouse today.',
   '<table width="100%"><tr><td><h1>On its way</h1><p>Your order left the warehouse today.</p></td></tr></table>',
   ${ago(604800)}, ${ago(4320000)}, 'org_demo', 'hello@northwind.example', ''),
  ('tpl_3', 'invoice-reminder', 'Invoice reminder', 'Invoice {{invoice_id}} is due on {{due_date}}',
   'A gentle reminder that this invoice falls due shortly.',
   '<table width="100%"><tr><td><h1>Invoice {{invoice_id}}</h1><p>A gentle reminder that this invoice falls due shortly.</p></td></tr></table>',
   ${ago(1209600)}, ${ago(3456000)}, 'org_demo', 'billing@northwind.example', '');

INSERT INTO api_keys (id, name, hash, preview, scope, restrict_mailbox_id, last_used_at, created_at, org_id) VALUES
  ('key_1', 'Storefront',      'unusable-1', 'mv_live_a4f2…9c71', 'sending', 'mb_hello',   ${ago(1800)},  ${ago(4320000)}, 'org_demo'),
  ('key_2', 'Billing service', 'unusable-2', 'mv_live_77bd…10ae', 'sending', 'mb_billing', ${ago(43200)}, ${ago(2592000)}, 'org_demo'),
  ('key_3', 'Ops scripts',     'unusable-3', 'mv_live_e0c3…4b52', 'full',    NULL,         NULL,          ${ago(864000)},  'org_demo');

INSERT INTO messages
  (id, mailbox_id, direction, thread_id, rfc_message_id, from_addr, from_name, to_addr,
   subject, snippet, body_text, body_html, spf, dkim, dmarc, size, seen, created_at, starred, archived) VALUES
  ('msg_1', 'mb_hello', 'in', 'thr_1', '<a1@mail.example>',
   'priya@lumenworks.example', 'Priya Raghavan', 'hello@northwind.example',
   'Re: Bulk order for the autumn catalogue',
   'That works for us. If you can hold the pricing until the 30th we will take the full pallet rather than splitting it across two.',
   'That works for us. If you can hold the pricing until the 30th we will take the full pallet rather than splitting it across two.',
   '<p>Hi,</p><p>That works for us. If you can hold the pricing until the 30th we will take the full pallet rather than splitting it across two deliveries.</p><p>Two things before we sign off:</p><ul><li>The delivery address changes to the Dockside unit from the 22nd.</li><li>Please put the purchase order number on the invoice this time, otherwise it goes round our accounts team twice.</li></ul><p>Happy to get on a call if easier.</p><p>Best,<br>Priya</p>',
   'pass', 'pass', 'pass', 4821, 0, ${ago(900)}, 1, 0),
  ('msg_2', 'mb_support', 'in', 'thr_2', '<a2@mail.example>',
   'd.okafor@brightpath.example', 'Daniel Okafor', 'support@northwind.example',
   'Tracking number does not resolve',
   'The number on the dispatch note comes back as not found. Order 44192, shipped Tuesday. Screenshot attached.',
   'The number on the dispatch note comes back as not found. Order 44192, shipped Tuesday. Screenshot attached.',
   '<p>The number on the dispatch note comes back as not found. Order 44192, shipped Tuesday.</p>',
   'pass', 'pass', 'pass', 91244, 0, ${ago(5400)}, 0, 0),
  ('msg_3', 'mb_hello', 'out', 'thr_3', '<a3@mail.example>',
   'hello@northwind.example', 'Northwind Supply', 'marta@fieldstone.example',
   'Your quote, and the lead time you asked about',
   'Attached. Lead time is eleven working days from order, which is two days better than what I quoted on the call.',
   'Attached. Lead time is eleven working days from order, which is two days better than what I quoted on the call.',
   '<p>Attached. Lead time is eleven working days from order, which is two days better than what I quoted on the call.</p>',
   NULL, NULL, NULL, 12903, 1, ${ago(12600)}, 0, 0),
  ('msg_4', 'mb_billing', 'in', 'thr_4', '<a4@mail.example>',
   'accounts@keystoneparts.example', 'Keystone Parts', 'billing@northwind.example',
   'Remittance advice 8871',
   'Payment sent this morning covering invoices 2210 through 2214. Reference NW-8871.',
   'Payment sent this morning covering invoices 2210 through 2214. Reference NW-8871.',
   '<p>Payment sent this morning covering invoices 2210 through 2214. Reference NW-8871.</p>',
   'pass', 'pass', 'pass', 3310, 1, ${ago(28800)}, 0, 0),
  ('msg_5', 'mb_support', 'in', 'thr_5', '<a5@mail.example>',
   'yuki.tanaka@aeriform.example', 'Yuki Tanaka', 'support@northwind.example',
   'Can we change the delivery window?',
   'Anything after 14:00 on Thursday would help. The loading bay is booked solid until then.',
   'Anything after 14:00 on Thursday would help. The loading bay is booked solid until then.',
   '<p>Anything after 14:00 on Thursday would help. The loading bay is booked solid until then.</p>',
   'pass', 'pass', 'pass', 2884, 1, ${ago(90000)}, 0, 0),
  ('msg_6', 'mb_hello', 'in', 'thr_6', '<a6@mail.example>',
   'newsletter@sawmilljournal.example', 'The Sawmill Journal', 'hello@northwind.example',
   'August issue: timber pricing, and what the port strike changed',
   'Our August round-up of pricing across the region, plus the three suppliers who held their rates.',
   'Our August round-up of pricing across the region, plus the three suppliers who held their rates.',
   '<p>Our August round-up of pricing across the region, plus the three suppliers who held their rates.</p>',
   'pass', 'pass', 'fail', 68140, 1, ${ago(176400)}, 0, 0);
`;

if (process.argv.includes("--remote")) {
  console.error(c.red("  Refusing: this script seeds the local database only."));
  console.error("  It deletes every row before inserting. Never point it at production.");
  process.exit(1);
}

const file = join(tmpdir(), `mittova-seed-${process.pid}.sql`);
writeFileSync(file, SQL);

try {
  console.log(c.bold("Seeding the local database with demo content"));
  wrangler(["d1", "execute", DB, "--local", "--file", file]);
  console.log(
    `  ${c.green("done")} — 2 organizations, 3 mailboxes, 4 users, 3 templates, 3 keys, 6 messages`,
  );
  console.log(c.dim("  Run `npm run dev`, then sign in with the ADMIN_PASSWORD from .dev.vars"));
  console.log(c.dim("  and an empty email field.\n"));
} catch (err) {
  console.error(c.red("  Failed."), err.stderr?.toString().trim() || err.message);
  console.error(c.dim("  Has the schema been applied? Try `npm run db:apply:local` first."));
  process.exitCode = 1;
} finally {
  try {
    unlinkSync(file);
  } catch {
    // Best effort: a leftover temp file is harmless.
  }
}
