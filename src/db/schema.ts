import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * The tenant. One org per client, holding its domains, mailboxes, people and
 * settings.
 *
 * Seeded one per domain, so today an org and a domain are the same thing. The
 * indirection exists because a client acquiring a second domain is ordinary,
 * and without it that would mean two disconnected tenants who cannot share a
 * contact list, a template or a login.
 */
export const organizations = sqliteTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /**
     * Outbound messages this tenant may send in any rolling 24 hours; 0 means
     * unlimited. Per-mailbox caps bound one address, but a client with twenty
     * mailboxes could still spend the whole deployment's reputation, so the
     * tenant needs its own ceiling.
     */
    dailySendLimit: integer("daily_send_limit").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("organizations_slug_idx").on(t.slug)],
);

/**
 * Sending domains. Held in the database rather than only in MAIL_DOMAIN so an
 * owner can add one from the dashboard without a redeploy. The env var still
 * seeds the first domain on a fresh install.
 */
export const domains = sqliteTable(
  "domains",
  {
    id: text("id").primaryKey(),
    domain: text("domain").notNull(),
    /** Cloudflare zone that owns it, for Email Routing rule management. */
    zoneId: text("zone_id").notNull().default(""),
    orgId: text("org_id").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    // A domain belongs to exactly one tenant, so this stays globally unique.
    uniqueIndex("domains_domain_idx").on(t.domain),
    index("domains_org_idx").on(t.orgId),
  ],
);

export const mailboxes = sqliteTable(
  "mailboxes",
  {
    id: text("id").primaryKey(),
    address: text("address").notNull(),
    name: text("name").notNull().default(""),
    /** Phase 2 abuse control: outbound messages allowed per rolling 24h. */
    dailySendLimit: integer("daily_send_limit").notNull().default(200),
    /** Cloudflare Email Routing rule delivering this address to the Worker. */
    routingRuleId: text("routing_rule_id"),
    /**
     * Where replies to mail from this mailbox should be addressed, when that is
     * not the mailbox itself — a no-reply address routing answers to a staffed
     * desk. Empty means reply to this address, which is the usual case.
     */
    replyTo: text("reply_to").notNull().default(""),
    /**
     * Denormalised from address -> domain -> org. Messages and drafts filter by
     * mailbox, so holding the org here keeps those queries one indexed
     * predicate rather than a three table join on the hot path.
     */
    orgId: text("org_id").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    // An address is globally unique regardless of who owns it.
    uniqueIndex("mailboxes_address_idx").on(t.address),
    index("mailboxes_org_idx").on(t.orgId),
  ],
);

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull().default(""),
    /** owner manages the org; member only sees assigned mailboxes within it. */
    role: text("role", { enum: ["owner", "member"] }).notNull().default("member"),
    /**
     * The org this person belongs to. Empty means a platform administrator who
     * can act in any org, which is also what the break-glass ADMIN_PASSWORD
     * login gets, since it has no row here at all.
     */
    orgId: text("org_id").notNull().default(""),
    /** PBKDF2-SHA256. Salt and derived key are hex; iterations stored so it can be raised later. */
    passwordHash: text("password_hash").notNull(),
    passwordSalt: text("password_salt").notNull(),
    passwordIterations: integer("password_iterations").notNull().default(200_000),
    /** Set when an owner assigns the password, cleared once the user picks their own. */
    mustChangePassword: integer("must_change_password").notNull().default(1),
    /**
     * SHA-256 of a single-use invite token, or null once accepted.
     *
     * Only the hash is stored, for the same reason as API keys: a leaked
     * database should not hand over a working way in. The account exists from
     * the moment it is invited but has no usable password until accepted, so
     * nobody has to transmit one.
     */
    inviteHash: text("invite_hash"),
    inviteExpiresAt: integer("invite_expires_at"),
    disabled: integer("disabled").notNull().default(0),
    /** Email-safe HTML appended when this person composes. */
    signature: text("signature").notNull().default(""),
    lastLoginAt: integer("last_login_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    // One login per person, so this stays globally unique: a given email
    // address is one human, belonging to one org.
    uniqueIndex("users_email_idx").on(t.email),
    index("users_org_idx").on(t.orgId),
  ],
);

/** Many-to-many: a support desk can be worked by several people. */
export const userMailboxes = sqliteTable(
  "user_mailboxes",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("user_mailboxes_pair_idx").on(t.userId, t.mailboxId),
    index("user_mailboxes_user_idx").on(t.userId),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    direction: text("direction", { enum: ["in", "out"] }).notNull(),
    /** Root RFC Message-ID of the conversation; groups a thread. */
    threadId: text("thread_id").notNull(),
    rfcMessageId: text("rfc_message_id"),
    inReplyTo: text("in_reply_to"),
    /** RFC 2822 References header, space separated. */
    msgReferences: text("msg_references"),
    fromAddr: text("from_addr").notNull(),
    fromName: text("from_name").notNull().default(""),
    toAddr: text("to_addr").notNull(),
    ccAddr: text("cc_addr"),
    subject: text("subject").notNull().default(""),
    snippet: text("snippet").notNull().default(""),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    spf: text("spf"),
    dkim: text("dkim"),
    dmarc: text("dmarc"),
    /** R2 key of the raw MIME source, inbound only. */
    rawKey: text("raw_key"),
    size: integer("size").notNull().default(0),
    /**
     * Legacy account-wide read flag. Still authoritative for the break-glass
     * admin, who has no user row; per-user state lives in messageReads.
     */
    seen: integer("seen").notNull().default(0),
    assignedToUserId: text("assigned_to_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Out of the inbox but not deleted. */
    archived: integer("archived").notNull().default(0),
    starred: integer("starred").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    // Leading with mailboxId serves the permission filter, then archived (the
    // default list excludes archived), then createdAt for the ORDER BY.
    index("messages_mailbox_archived_created_idx").on(t.mailboxId, t.archived, t.createdAt),
    index("messages_assigned_idx").on(t.assignedToUserId),
    // starred is highly selective, so this keeps view=starred off a full scan.
    index("messages_starred_created_idx").on(t.starred, t.createdAt),
    index("messages_thread_idx").on(t.threadId, t.createdAt),
    index("messages_rfc_idx").on(t.rfcMessageId),
  ],
);

/** Unsent compositions, autosaved so closing the composer is not destructive. */
export const drafts = sqliteTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    /** Null for the break-glass admin, who has no user row. */
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    toAddr: text("to_addr").notNull().default(""),
    ccAddr: text("cc_addr").notNull().default(""),
    bccAddr: text("bcc_addr").notNull().default(""),
    subject: text("subject").notNull().default(""),
    bodyHtml: text("body_html").notNull().default(""),
    /** Set when the draft is a reply, so threading survives a reload. */
    replyToMessageId: text("reply_to_message_id"),
    updatedAt: integer("updated_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("drafts_user_updated_idx").on(t.userId, t.updatedAt)],
);

/** Append-only trail of privileged actions, for answering "who did that". */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id"),
    actorEmail: text("actor_email").notNull(),
    action: text("action").notNull(),
    target: text("target").notNull().default(""),
    detail: text("detail").notNull().default(""),
    /** Tenant the action happened in; empty for platform-level actions. */
    orgId: text("org_id").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("audit_log_created_idx").on(t.createdAt),
    index("audit_log_org_created_idx").on(t.orgId, t.createdAt),
  ],
);

/**
 * Per-user read markers. A shared support desk needs these: without them, the
 * first person to open a message marks it read for everyone.
 */
export const messageReads = sqliteTable(
  "message_reads",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    readAt: integer("read_at").notNull(),
  },
  (t) => [
    uniqueIndex("message_reads_pair_idx").on(t.userId, t.messageId),
    index("message_reads_user_idx").on(t.userId),
  ],
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull().default("application/octet-stream"),
    size: integer("size").notNull().default(0),
    contentId: text("content_id"),
    r2Key: text("r2_key").notNull(),
  },
  (t) => [index("attachments_message_idx").on(t.messageId)],
);

/**
 * Append-only lifecycle log per message — what powers the detail timeline.
 * Types: queued, sent, delivered, delivery_failed, received, rejected, bounced.
 */
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    detail: text("detail"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("events_message_idx").on(t.messageId, t.createdAt)],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** SHA-256 of the full key. The plaintext is shown once at creation and never stored. */
    hash: text("hash").notNull(),
    /** Display-only, e.g. "mv_live_a1b2…f7c9". */
    preview: text("preview").notNull(),
    /** "full" can send from any mailbox; "sending" is restricted to restrictMailboxId. */
    scope: text("scope", { enum: ["full", "sending"] }).notNull().default("sending"),
    restrictMailboxId: text("restrict_mailbox_id").references(() => mailboxes.id, {
      onDelete: "cascade",
    }),
    orgId: text("org_id").notNull().default(""),
    lastUsedAt: integer("last_used_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("api_keys_hash_idx").on(t.hash), index("api_keys_org_idx").on(t.orgId)],
);

export const webhooks = sqliteTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    /** JSON array of event type strings this endpoint subscribes to. */
    eventTypes: text("event_types").notNull().default('["*"]'),
    /** Shared secret for the X-Mittova-Signature HMAC. */
    secret: text("secret").notNull(),
    enabled: integer("enabled").notNull().default(1),
    orgId: text("org_id").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("webhooks_org_idx").on(t.orgId)],
);

export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    statusCode: integer("status_code"),
    error: text("error"),
    durationMs: integer("duration_ms"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("webhook_deliveries_hook_idx").on(t.webhookId, t.createdAt)],
);

export const templates = sqliteTable(
  "templates",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    subject: text("subject").notNull().default(""),
    bodyText: text("body_text").notNull().default(""),
    bodyHtml: text("body_html"),
    /**
     * Default sender for this template, as a mailbox address. Empty means the
     * send decides. Validated against the org's own mailboxes on write: you may
     * only ever send as an address this deployment receives for.
     */
    fromAddress: text("from_address").notNull().default(""),
    /** Default Reply-To. Empty falls through to the mailbox's own setting. */
    replyTo: text("reply_to").notNull().default(""),
    orgId: text("org_id").notNull().default(""),
    updatedAt: integer("updated_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  // Per org: two clients may both keep a "welcome" template.
  (t) => [uniqueIndex("templates_org_slug_idx").on(t.orgId, t.slug)],
);

/**
 * Previous states of a template, written before each overwrite.
 *
 * A template is production copy that other systems send by slug, so an
 * accidental save is a live incident. Rows are the state *before* an edit, so
 * the list reads as "what it used to be" and restoring is picking one.
 */
export const templateVersions = sqliteTable(
  "template_versions",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id")
      .notNull()
      .references(() => templates.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull().default(""),
    /**
     * Every field a restore writes back. A snapshot missing one is worse than
     * no snapshot: restoring looks like it worked and quietly leaves that field
     * at its current value.
     */
    name: text("name").notNull().default(""),
    subject: text("subject").notNull().default(""),
    bodyText: text("body_text").notNull().default(""),
    bodyHtml: text("body_html"),
    fromAddress: text("from_address").notNull().default(""),
    replyTo: text("reply_to").notNull().default(""),
    /** Who saved over it. */
    actorEmail: text("actor_email").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("template_versions_tpl_idx").on(t.templateId, t.createdAt)],
);

export const contacts = sqliteTable(
  "contacts",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull().default(""),
    company: text("company").notNull().default(""),
    notes: text("notes").notNull().default(""),
    orgId: text("org_id").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  // Per org: the same person can be a contact of more than one client.
  (t) => [uniqueIndex("contacts_org_email_idx").on(t.orgId, t.email)],
);

/** Addresses we refuse to send to: hard bounces, complaints, manual blocks. */
export const suppressions = sqliteTable(
  "suppressions",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    reason: text("reason", { enum: ["bounce", "complaint", "manual"] })
      .notNull()
      .default("manual"),
    detail: text("detail").notNull().default(""),
    orgId: text("org_id").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  /**
   * Per org rather than global. A bounce is evidence about one sender's
   * relationship with a recipient: one client hard-bouncing an address is no
   * reason to stop another client mailing the same person, and sharing the list
   * would also leak who each client mails.
   */
  (t) => [uniqueIndex("suppressions_org_email_idx").on(t.orgId, t.email)],
);

export type Organization = typeof organizations.$inferSelect;
export type Domain = typeof domains.$inferSelect;
export type Mailbox = typeof mailboxes.$inferSelect;
export type User = typeof users.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type MessageEvent = typeof events.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type Template = typeof templates.$inferSelect;
export type TemplateVersion = typeof templateVersions.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Suppression = typeof suppressions.$inferSelect;
export type MessageRead = typeof messageReads.$inferSelect;
export type Draft = typeof drafts.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
