-- Demo content: the single source for both the local seed script and the
-- hourly reset the demo deployment runs on itself.
--
-- `scripts/seed-demo.mjs` reads this file and pipes it into the local D1.
-- `src/services/demo.ts` imports it as a text module and executes it inside the
-- Worker, which is what lets demo.mittova.com reset itself without an external
-- scheduler and without any stored credential. There is deliberately no second
-- copy: the two consumers must never be able to disagree about what the demo
-- contains.
--
-- Everything here is fabricated. Every domain sits under .example, a reserved
-- TLD that can never be registered, so nothing here can address a real mailbox.
-- The password and API key hashes are placeholders corresponding to no
-- credential: none of these accounts can be signed into, and none of these keys
-- has ever existed. Signing in is the ADMIN_PASSWORD break-glass login, with an
-- empty email field.
--
-- Timestamps are relative to now so the dashboard shows plausible ages rather
-- than a wall of identical dates. Whole seconds, in milliseconds.
--
-- Statements are split on semicolons by a parser that understands single-quoted
-- strings, so an apostrophe inside a value is safe. Both consumers run the
-- whole file as one batch, which D1 wraps in a transaction: a reset either
-- lands completely or not at all.

-- Wipe first, children before parents. Everything a visitor can create has to
-- be listed here, or their leftovers survive the reset and accumulate.
DELETE FROM template_versions;
DELETE FROM templates;
DELETE FROM webhook_deliveries;
DELETE FROM webhooks;
DELETE FROM api_keys;
DELETE FROM events;
DELETE FROM attachments;
DELETE FROM message_reads;
DELETE FROM drafts;
DELETE FROM messages;
DELETE FROM user_mailboxes;
DELETE FROM users;
DELETE FROM mailboxes;
DELETE FROM domains;
DELETE FROM organizations;
DELETE FROM contacts;
DELETE FROM suppressions;
DELETE FROM audit_log;

-- Two tenants, so the organization switcher has somewhere to switch to and the
-- boundary between them is something a visitor can actually try to cross.
INSERT INTO organizations (id, name, slug, created_at, daily_send_limit) VALUES
  ('org_demo', 'Northwind Supply', 'northwind', (strftime('%s','now') - 5184000) * 1000, 2000),
  ('org_two', 'Harbourline Freight', 'harbourline', (strftime('%s','now') - 2592000) * 1000, 500);

INSERT INTO domains (id, domain, zone_id, created_at, org_id) VALUES
  ('dom_demo', 'northwind.example', '', (strftime('%s','now') - 5184000) * 1000, 'org_demo'),
  ('dom_two', 'harbourline.example', '', (strftime('%s','now') - 2592000) * 1000, 'org_two');

INSERT INTO mailboxes (id, address, name, daily_send_limit, created_at, org_id, reply_to) VALUES
  ('mb_hello',   'hello@northwind.example',   'Hello',   500, (strftime('%s','now') - 5184000) * 1000, 'org_demo', ''),
  ('mb_support', 'support@northwind.example', 'Support', 500, (strftime('%s','now') - 5184000) * 1000, 'org_demo', ''),
  ('mb_billing', 'billing@northwind.example', 'Billing', 200, (strftime('%s','now') - 5184000) * 1000, 'org_demo', ''),
  ('mb_ops',     'ops@harbourline.example',   'Ops',     200, (strftime('%s','now') - 2592000) * 1000, 'org_two',  '');

INSERT INTO users (id, email, name, role, password_hash, password_salt, password_iterations,
                   must_change_password, disabled, signature, last_login_at, created_at, org_id) VALUES
  ('usr_1', 'imogen@northwind.example', 'Imogen Clarke', 'owner',  'unusable', 'unusable', 200000, 0, 0, '', (strftime('%s','now') - 3600) * 1000,   (strftime('%s','now') - 5184000) * 1000, 'org_demo'),
  ('usr_2', 'ravi@northwind.example',   'Ravi Menon',    'member', 'unusable', 'unusable', 200000, 0, 0, '', (strftime('%s','now') - 86400) * 1000,  (strftime('%s','now') - 4320000) * 1000, 'org_demo'),
  ('usr_3', 'sofia@northwind.example',  'Sofia Almeida', 'member', 'unusable', 'unusable', 200000, 0, 0, '', (strftime('%s','now') - 259200) * 1000, (strftime('%s','now') - 2592000) * 1000, 'org_demo'),
  ('usr_4', 'ops@harbourline.example',  'Tomas Berg',    'owner',  'unusable', 'unusable', 200000, 0, 0, '', (strftime('%s','now') - 7200) * 1000,   (strftime('%s','now') - 2592000) * 1000, 'org_two');

INSERT INTO user_mailboxes (user_id, mailbox_id, created_at) VALUES
  ('usr_1', 'mb_hello',   (strftime('%s','now') - 5184000) * 1000),
  ('usr_1', 'mb_support', (strftime('%s','now') - 5184000) * 1000),
  ('usr_1', 'mb_billing', (strftime('%s','now') - 5184000) * 1000),
  ('usr_2', 'mb_support', (strftime('%s','now') - 4320000) * 1000),
  ('usr_3', 'mb_support', (strftime('%s','now') - 2592000) * 1000),
  ('usr_3', 'mb_hello',   (strftime('%s','now') - 2592000) * 1000),
  ('usr_4', 'mb_ops',     (strftime('%s','now') - 2592000) * 1000);

INSERT INTO templates (id, slug, name, subject, body_text, body_html, updated_at, created_at, org_id, from_address, reply_to) VALUES
  ('tpl_1', 'order-confirmation', 'Order confirmation', 'Your order {{order_id}} is confirmed',
   'Thanks for your order. We will let you know when it ships.',
   '<table width="100%"><tr><td><h1>Order {{order_id}} confirmed</h1><p>Thanks for your order. We will let you know when it ships.</p></td></tr></table>',
   (strftime('%s','now') - 172800) * 1000, (strftime('%s','now') - 4320000) * 1000, 'org_demo', 'hello@northwind.example', ''),
  ('tpl_2', 'dispatch-notice', 'Dispatch notice', 'Order {{order_id}} is on its way',
   'Your order left the warehouse today.',
   '<table width="100%"><tr><td><h1>On its way</h1><p>Your order left the warehouse today.</p></td></tr></table>',
   (strftime('%s','now') - 604800) * 1000, (strftime('%s','now') - 4320000) * 1000, 'org_demo', 'hello@northwind.example', ''),
  ('tpl_3', 'invoice-reminder', 'Invoice reminder', 'Invoice {{invoice_id}} is due on {{due_date}}',
   'A gentle reminder that this invoice falls due shortly.',
   '<table width="100%"><tr><td><h1>Invoice {{invoice_id}}</h1><p>A gentle reminder that this invoice falls due shortly.</p></td></tr></table>',
   (strftime('%s','now') - 1209600) * 1000, (strftime('%s','now') - 3456000) * 1000, 'org_demo', 'billing@northwind.example', ''),
  ('tpl_4', 'booking-confirmed', 'Booking confirmed', 'Container {{container_id}} is booked',
   'Your container is booked onto the Thursday sailing.',
   '<table width="100%"><tr><td><h1>Booking confirmed</h1><p>Your container is booked onto the Thursday sailing.</p></td></tr></table>',
   (strftime('%s','now') - 259200) * 1000, (strftime('%s','now') - 2160000) * 1000, 'org_two', 'ops@harbourline.example', '');

-- One previous state, so the template version history is not an empty panel.
INSERT INTO template_versions (id, template_id, org_id, name, subject, body_text, body_html,
                               from_address, reply_to, actor_email, created_at) VALUES
  ('tvr_1', 'tpl_1', 'org_demo', 'Order confirmation', 'Order {{order_id}} confirmed',
   'Thanks for your order.',
   '<table width="100%"><tr><td><h1>Order {{order_id}}</h1><p>Thanks for your order.</p></td></tr></table>',
   'hello@northwind.example', '', 'imogen@northwind.example', (strftime('%s','now') - 172800) * 1000);

INSERT INTO api_keys (id, name, hash, preview, scope, restrict_mailbox_id, last_used_at, created_at, org_id) VALUES
  ('key_1', 'Storefront',      'unusable-1', 'mv_live_a4f2…9c71', 'sending', 'mb_hello',   (strftime('%s','now') - 1800) * 1000,  (strftime('%s','now') - 4320000) * 1000, 'org_demo'),
  ('key_2', 'Billing service', 'unusable-2', 'mv_live_77bd…10ae', 'sending', 'mb_billing', (strftime('%s','now') - 43200) * 1000, (strftime('%s','now') - 2592000) * 1000, 'org_demo'),
  ('key_3', 'Ops scripts',     'unusable-3', 'mv_live_e0c3…4b52', 'full',    NULL,         NULL,                                  (strftime('%s','now') - 864000) * 1000,  'org_demo'),
  ('key_4', 'Manifest import', 'unusable-4', 'mv_live_b915…7d30', 'sending', 'mb_ops',     (strftime('%s','now') - 9000) * 1000,  (strftime('%s','now') - 1728000) * 1000, 'org_two');

INSERT INTO webhooks (id, url, event_types, secret, enabled, org_id, created_at) VALUES
  ('whk_1', 'https://hooks.northwind.example/mittova', '["*"]', 'unusable-secret-1', 1, 'org_demo', (strftime('%s','now') - 3456000) * 1000),
  ('whk_2', 'https://ops.harbourline.example/inbound', '["email.received"]', 'unusable-secret-2', 1, 'org_two', (strftime('%s','now') - 1728000) * 1000);

INSERT INTO contacts (id, email, name, company, notes, org_id, created_at) VALUES
  ('cnt_1', 'priya@lumenworks.example',      'Priya Raghavan', 'Lumenworks',   'Autumn catalogue, pallet pricing held to the 30th.', 'org_demo', (strftime('%s','now') - 3456000) * 1000),
  ('cnt_2', 'marta@fieldstone.example',      'Marta Nowak',    'Fieldstone',   'Quoted eleven working days lead time.',              'org_demo', (strftime('%s','now') - 2592000) * 1000),
  ('cnt_3', 'accounts@keystoneparts.example','Keystone Parts', 'Keystone',     'Pays on remittance advice, reference NW-prefix.',    'org_demo', (strftime('%s','now') - 1728000) * 1000),
  ('cnt_4', 'desk@portside.example',         'Portside Agency','Portside',     'Books the Thursday sailing most weeks.',             'org_two',  (strftime('%s','now') - 1209600) * 1000);

INSERT INTO suppressions (id, email, reason, detail, org_id, created_at) VALUES
  ('sup_1', 'old-address@brightpath.example', 'bounce', '550 5.1.1 recipient address rejected', 'org_demo', (strftime('%s','now') - 1209600) * 1000),
  ('sup_2', 'unsubscribed@fieldstone.example', 'complaint', 'marked as spam by the recipient',   'org_demo', (strftime('%s','now') - 604800) * 1000);

-- raw_key is set on inbound messages only, matching the layout in
-- src/services/storage.ts. The reset writes an object at each of these keys, so
-- "view raw source" works on the demo rather than 404ing.
INSERT INTO messages
  (id, mailbox_id, direction, thread_id, rfc_message_id, from_addr, from_name, to_addr,
   subject, snippet, body_text, body_html, spf, dkim, dmarc, raw_key, size, seen, created_at, starred, archived) VALUES
  ('msg_1', 'mb_hello', 'in', 'thr_1', '<a1@mail.example>',
   'priya@lumenworks.example', 'Priya Raghavan', 'hello@northwind.example',
   'Re: Bulk order for the autumn catalogue',
   'That works for us. If you can hold the pricing until the 30th we will take the full pallet rather than splitting it across two.',
   'That works for us. If you can hold the pricing until the 30th we will take the full pallet rather than splitting it across two.',
   '<p>Hi,</p><p>That works for us. If you can hold the pricing until the 30th we will take the full pallet rather than splitting it across two deliveries.</p><p>Two things before we sign off:</p><ul><li>The delivery address changes to the Dockside unit from the 22nd.</li><li>Please put the purchase order number on the invoice this time, otherwise it goes round our accounts team twice.</li></ul><p>Happy to get on a call if easier.</p><p>Best,<br>Priya</p>',
   'pass', 'pass', 'pass', 'northwind.example/raw/mb_hello/msg_1.eml', 4821, 0, (strftime('%s','now') - 900) * 1000, 1, 0),
  ('msg_2', 'mb_support', 'in', 'thr_2', '<a2@mail.example>',
   'd.okafor@brightpath.example', 'Daniel Okafor', 'support@northwind.example',
   'Tracking number does not resolve',
   'The number on the dispatch note comes back as not found. Order 44192, shipped Tuesday. Screenshot attached.',
   'The number on the dispatch note comes back as not found. Order 44192, shipped Tuesday. Screenshot attached.',
   '<p>The number on the dispatch note comes back as not found. Order 44192, shipped Tuesday.</p>',
   'pass', 'pass', 'pass', 'northwind.example/raw/mb_support/msg_2.eml', 91244, 0, (strftime('%s','now') - 5400) * 1000, 0, 0),
  ('msg_3', 'mb_hello', 'out', 'thr_3', '<a3@mail.example>',
   'hello@northwind.example', 'Northwind Supply', 'marta@fieldstone.example',
   'Your quote, and the lead time you asked about',
   'Attached. Lead time is eleven working days from order, which is two days better than what I quoted on the call.',
   'Attached. Lead time is eleven working days from order, which is two days better than what I quoted on the call.',
   '<p>Attached. Lead time is eleven working days from order, which is two days better than what I quoted on the call.</p>',
   NULL, NULL, NULL, NULL, 12903, 1, (strftime('%s','now') - 12600) * 1000, 0, 0),
  ('msg_4', 'mb_billing', 'in', 'thr_4', '<a4@mail.example>',
   'accounts@keystoneparts.example', 'Keystone Parts', 'billing@northwind.example',
   'Remittance advice 8871',
   'Payment sent this morning covering invoices 2210 through 2214. Reference NW-8871.',
   'Payment sent this morning covering invoices 2210 through 2214. Reference NW-8871.',
   '<p>Payment sent this morning covering invoices 2210 through 2214. Reference NW-8871.</p>',
   'pass', 'pass', 'pass', 'northwind.example/raw/mb_billing/msg_4.eml', 3310, 1, (strftime('%s','now') - 28800) * 1000, 0, 0),
  ('msg_5', 'mb_support', 'in', 'thr_5', '<a5@mail.example>',
   'yuki.tanaka@aeriform.example', 'Yuki Tanaka', 'support@northwind.example',
   'Can we change the delivery window?',
   'Anything after 14:00 on Thursday would help. The loading bay is booked solid until then.',
   'Anything after 14:00 on Thursday would help. The loading bay is booked solid until then.',
   '<p>Anything after 14:00 on Thursday would help. The loading bay is booked solid until then.</p>',
   'pass', 'pass', 'pass', 'northwind.example/raw/mb_support/msg_5.eml', 2884, 1, (strftime('%s','now') - 90000) * 1000, 0, 0),
  ('msg_6', 'mb_hello', 'in', 'thr_6', '<a6@mail.example>',
   'newsletter@sawmilljournal.example', 'The Sawmill Journal', 'hello@northwind.example',
   'August issue: timber pricing, and what the port strike changed',
   'Our August round-up of pricing across the region, plus the three suppliers who held their rates.',
   'Our August round-up of pricing across the region, plus the three suppliers who held their rates.',
   '<p>Our August round-up of pricing across the region, plus the three suppliers who held their rates.</p>',
   'pass', 'pass', 'fail', 'northwind.example/raw/mb_hello/msg_6.eml', 68140, 1, (strftime('%s','now') - 176400) * 1000, 0, 0),
  -- A failing SPF, so the authentication panel has something other than three
  -- green ticks to show.
  ('msg_7', 'mb_support', 'in', 'thr_7', '<a7@mail.example>',
   'billing@northwlnd-supply.example', 'Northwind Accounts', 'support@northwind.example',
   'Urgent: update your payment details',
   'Please confirm the new account number before the next invoice run.',
   'Please confirm the new account number before the next invoice run.',
   '<p>Please confirm the new account number before the next invoice run.</p>',
   'fail', 'fail', 'fail', 'northwind.example/raw/mb_support/msg_7.eml', 5120, 0, (strftime('%s','now') - 39600) * 1000, 0, 0),
  -- Harbourline's own mail, so switching organization shows a different inbox
  -- rather than an empty one.
  ('msg_8', 'mb_ops', 'in', 'thr_8', '<a8@mail.example>',
   'desk@portside.example', 'Portside Agency', 'ops@harbourline.example',
   'Thursday sailing: two containers, not three',
   'One of the three fell through, so we only need two slots on Thursday.',
   'One of the three fell through, so we only need two slots on Thursday.',
   '<p>One of the three fell through, so we only need two slots on Thursday.</p>',
   'pass', 'pass', 'pass', 'harbourline.example/raw/mb_ops/msg_8.eml', 3980, 0, (strftime('%s','now') - 2700) * 1000, 0, 0),
  ('msg_9', 'mb_ops', 'out', 'thr_8', '<a9@mail.example>',
   'ops@harbourline.example', 'Harbourline Freight', 'desk@portside.example',
   'Re: Thursday sailing: two containers, not three',
   'Noted, amended to two. The manifest will go out tomorrow morning.',
   'Noted, amended to two. The manifest will go out tomorrow morning.',
   '<p>Noted, amended to two. The manifest will go out tomorrow morning.</p>',
   NULL, NULL, NULL, NULL, 2210, 1, (strftime('%s','now') - 1800) * 1000, 0, 0);

INSERT INTO events (id, message_id, type, detail, created_at) VALUES
  ('evt_1', 'msg_1', 'received',  'accepted from mail.example',                        (strftime('%s','now') - 900) * 1000),
  ('evt_2', 'msg_3', 'sent',      'accepted by Cloudflare Email Service',              (strftime('%s','now') - 12600) * 1000),
  ('evt_3', 'msg_3', 'delivered', 'delivered to fieldstone.example',                   (strftime('%s','now') - 12480) * 1000),
  ('evt_4', 'msg_7', 'received',  'accepted, authentication failed on SPF, DKIM, DMARC',(strftime('%s','now') - 39600) * 1000),
  ('evt_5', 'msg_9', 'sent',      'accepted by Cloudflare Email Service',              (strftime('%s','now') - 1800) * 1000);

INSERT INTO audit_log (id, actor_id, actor_email, action, target, detail, org_id, created_at) VALUES
  ('aud_1', 'usr_1', 'imogen@northwind.example', 'template.update', 'order-confirmation', 'subject and body edited', 'org_demo', (strftime('%s','now') - 172800) * 1000),
  ('aud_2', 'usr_1', 'imogen@northwind.example', 'apikey.create',   'Storefront',         'scope sending, restricted to hello@northwind.example', 'org_demo', (strftime('%s','now') - 4320000) * 1000),
  ('aud_3', 'usr_1', 'imogen@northwind.example', 'user.invite',     'sofia@northwind.example', 'invited as member', 'org_demo', (strftime('%s','now') - 2592000) * 1000),
  ('aud_4', 'usr_4', 'ops@harbourline.example',  'apikey.create',   'Manifest import',    'scope sending, restricted to ops@harbourline.example', 'org_two', (strftime('%s','now') - 1728000) * 1000);
