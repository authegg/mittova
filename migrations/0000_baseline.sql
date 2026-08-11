-- Mittova schema, v1.
--
-- A squashed baseline: the migrations that built up to this point are replaced
-- by the state they produced, so a new deployment creates the schema once
-- rather than replaying its history.
--
-- Generated from the running database, not from schema.ts. drizzle-kit cannot
-- model the FTS5 virtual table or the three triggers that keep it in step with
-- messages, so a generated baseline would silently ship without search.
--
-- Deliberately absent: the shadow tables FTS5 creates for itself from CREATE
-- VIRTUAL TABLE, and d1_migrations, sqlite_sequence and _cf_KV, which belong to
-- D1 and wrangler rather than to this schema.
--
-- A deployment already on an older baseline will NOT receive this: wrangler
-- tracks migrations by tag and skips one it has run before. See README.

--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`hash` text NOT NULL,
	`preview` text NOT NULL,
	`scope` text DEFAULT 'sending' NOT NULL,
	`restrict_mailbox_id` text,
	`last_used_at` integer,
	`created_at` integer NOT NULL, `org_id` text NOT NULL DEFAULT '',
	FOREIGN KEY (`restrict_mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`content_id` text,
	`r2_key` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`actor_email` text NOT NULL,
	`action` text NOT NULL,
	`target` text DEFAULT '' NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
, `org_id` text NOT NULL DEFAULT '');
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`company` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
, `org_id` text NOT NULL DEFAULT '');
--> statement-breakpoint
CREATE TABLE `domains` (
	`id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`zone_id` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
, `org_id` text NOT NULL DEFAULT '');
--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`mailbox_id` text NOT NULL,
	`to_addr` text DEFAULT '' NOT NULL,
	`cc_addr` text DEFAULT '' NOT NULL,
	`bcc_addr` text DEFAULT '' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`body_html` text DEFAULT '' NOT NULL,
	`reply_to_message_id` text,
	`updated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`type` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`daily_send_limit` integer DEFAULT 200 NOT NULL,
	`created_at` integer NOT NULL
, `routing_rule_id` text, `org_id` text NOT NULL DEFAULT '', `reply_to` text DEFAULT '' NOT NULL);
--> statement-breakpoint
CREATE TABLE `message_reads` (
	`user_id` text NOT NULL,
	`message_id` text NOT NULL,
	`read_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`direction` text NOT NULL,
	`thread_id` text NOT NULL,
	`rfc_message_id` text,
	`in_reply_to` text,
	`msg_references` text,
	`from_addr` text NOT NULL,
	`from_name` text DEFAULT '' NOT NULL,
	`to_addr` text NOT NULL,
	`cc_addr` text,
	`subject` text DEFAULT '' NOT NULL,
	`snippet` text DEFAULT '' NOT NULL,
	`body_text` text,
	`body_html` text,
	`spf` text,
	`dkim` text,
	`dmarc` text,
	`raw_key` text,
	`size` integer DEFAULT 0 NOT NULL,
	`seen` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL, `assigned_to_user_id` text REFERENCES users(id), `archived` integer DEFAULT 0 NOT NULL, `starred` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE VIRTUAL TABLE messages_fts USING fts5(
  mid UNINDEXED,
  subject,
  from_addr,
  to_addr,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` integer NOT NULL
, `daily_send_limit` integer DEFAULT 0 NOT NULL);
--> statement-breakpoint
CREATE TABLE `suppressions` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`reason` text DEFAULT 'manual' NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
, `org_id` text NOT NULL DEFAULT '');
--> statement-breakpoint
CREATE TABLE `template_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`org_id` text DEFAULT '' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`body_text` text DEFAULT '' NOT NULL,
	`body_html` text,
	`from_address` text DEFAULT '' NOT NULL,
	`reply_to` text DEFAULT '' NOT NULL,
	`actor_email` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL, `name` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`body_text` text DEFAULT '' NOT NULL,
	`body_html` text,
	`updated_at` integer NOT NULL,
	`created_at` integer NOT NULL
, `org_id` text NOT NULL DEFAULT '', `from_address` text DEFAULT '' NOT NULL, `reply_to` text DEFAULT '' NOT NULL);
--> statement-breakpoint
CREATE TABLE `user_mailboxes` (
	`user_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "users" (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`password_iterations` integer DEFAULT 200000 NOT NULL,
	`must_change_password` integer DEFAULT 1 NOT NULL,
	`disabled` integer DEFAULT 0 NOT NULL,
	`signature` text DEFAULT '' NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL
, `org_id` text NOT NULL DEFAULT '', `invite_hash` text, `invite_expires_at` integer);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`event_type` text NOT NULL,
	`status_code` integer,
	`error` text,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`event_types` text DEFAULT '["*"]' NOT NULL,
	`secret` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
, `org_id` text NOT NULL DEFAULT '');
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_idx` ON `api_keys` (`hash`);
--> statement-breakpoint
CREATE INDEX `api_keys_org_idx` ON `api_keys` (`org_id`);
--> statement-breakpoint
CREATE INDEX `attachments_message_idx` ON `attachments` (`message_id`);
--> statement-breakpoint
CREATE INDEX `audit_log_created_idx` ON `audit_log` (`created_at`);
--> statement-breakpoint
CREATE INDEX `audit_log_org_created_idx` ON `audit_log` (`org_id`, `created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_org_email_idx` ON `contacts` (`org_id`, `email`);
--> statement-breakpoint
CREATE UNIQUE INDEX `domains_domain_idx` ON `domains` (`domain`);
--> statement-breakpoint
CREATE INDEX `domains_org_idx` ON `domains` (`org_id`);
--> statement-breakpoint
CREATE INDEX `drafts_user_updated_idx` ON `drafts` (`user_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `events_message_idx` ON `events` (`message_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_address_idx` ON `mailboxes` (`address`);
--> statement-breakpoint
CREATE INDEX `mailboxes_org_idx` ON `mailboxes` (`org_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_reads_pair_idx` ON `message_reads` (`user_id`,`message_id`);
--> statement-breakpoint
CREATE INDEX `message_reads_user_idx` ON `message_reads` (`user_id`);
--> statement-breakpoint
CREATE INDEX `messages_assigned_idx` ON `messages` (`assigned_to_user_id`);
--> statement-breakpoint
CREATE INDEX `messages_mailbox_archived_created_idx` ON `messages` (`mailbox_id`,`archived`,`created_at`);
--> statement-breakpoint
CREATE INDEX `messages_rfc_idx` ON `messages` (`rfc_message_id`);
--> statement-breakpoint
CREATE INDEX `messages_starred_created_idx` ON `messages` (`starred`,`created_at`);
--> statement-breakpoint
CREATE INDEX `messages_thread_idx` ON `messages` (`thread_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_idx` ON `organizations` (`slug`);
--> statement-breakpoint
CREATE UNIQUE INDEX `suppressions_org_email_idx` ON `suppressions` (`org_id`, `email`);
--> statement-breakpoint
CREATE INDEX `template_versions_tpl_idx` ON `template_versions` (`template_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `templates_org_slug_idx` ON `templates` (`org_id`, `slug`);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_mailboxes_pair_idx` ON `user_mailboxes` (`user_id`,`mailbox_id`);
--> statement-breakpoint
CREATE INDEX `user_mailboxes_user_idx` ON `user_mailboxes` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);
--> statement-breakpoint
CREATE INDEX `users_org_idx` ON `users` (`org_id`);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_hook_idx` ON `webhook_deliveries` (`webhook_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `webhooks_org_idx` ON `webhooks` (`org_id`);
--> statement-breakpoint
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE mid = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (mid, subject, from_addr, to_addr, body)
  VALUES (
    new.id,
    coalesce(new.subject, ''),
    coalesce(new.from_addr, ''),
    coalesce(new.to_addr, ''),
    coalesce(new.body_text, new.snippet, '')
  );
END;
--> statement-breakpoint
CREATE TRIGGER messages_fts_update AFTER UPDATE OF subject, from_addr, to_addr, body_text, snippet ON messages BEGIN
  DELETE FROM messages_fts WHERE mid = old.id;
  INSERT INTO messages_fts (mid, subject, from_addr, to_addr, body)
  VALUES (
    new.id,
    coalesce(new.subject, ''),
    coalesce(new.from_addr, ''),
    coalesce(new.to_addr, ''),
    coalesce(new.body_text, new.snippet, '')
  );
END;
