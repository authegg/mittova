export interface Mailbox {
  id: string;
  address: string;
  /** Which tenant owns it. A picker must not offer one across the boundary. */
  orgId: string;
  name: string;
  dailySendLimit: number;
  /** Standing Reply-To; empty means replies come back to this address. */
  replyTo: string;
  createdAt: number;
  routingRuleId: string | null;
  unread: number;
  sent24h: number;
  received: number;
  sent: number;
  /** null when the caller cannot query Cloudflare (member, or no API token). */
  routed: boolean | null;
}

export interface SessionUser {
  email: string;
  name: string;
  role: "owner" | "member";
  isRootAdmin: boolean;
  /** May act in any tenant, and is the only role that sees the org switcher. */
  isPlatformAdmin: boolean;
  /** Tenant currently in view; empty means every tenant at once. */
  orgId: string;
  mustChangePassword: boolean;
  mailboxCount: number | null;
  signature: string;
}

export interface Draft {
  id: string;
  mailboxId: string;
  toAddr: string;
  ccAddr: string;
  bccAddr: string;
  subject: string;
  bodyHtml: string;
  replyToMessageId: string | null;
  updatedAt: number;
}

export interface AuditEntry {
  id: string;
  actorEmail: string;
  action: string;
  target: string;
  detail: string;
  createdAt: number;
}

export interface BackupObject {
  key: string;
  size: number;
  uploaded: string;
}

/**
 * Set only by the public demo at demo.mittova.com. Null on every real
 * deployment, which is what keeps the banner and the published password off
 * anything that holds real mail.
 */
export interface DemoInfo {
  /** The break-glass password, shown on the sign-in screen. Public by design. */
  password: string;
}

export interface Me {
  authed: boolean;
  appName: string;
  domains: string[];
  user: SessionUser | null;
  routingAutomated: boolean;
  demo: DemoInfo | null;
}

export interface User {
  id: string;
  email: string;
  /** The tenant the account belongs to, which bounds what it can be assigned. */
  orgId: string | null;
  name: string;
  role: "owner" | "member";
  disabled: number;
  mustChangePassword: number;
  lastLoginAt: number | null;
  createdAt: number;
  mailboxIds: string[];
}

export interface MessageSummary {
  id: string;
  mailboxId: string;
  mailboxAddress: string;
  direction: "in" | "out";
  threadId: string;
  fromAddr: string;
  fromName: string;
  toAddr: string;
  subject: string;
  snippet: string;
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  seen: number;
  assignedToUserId: string | null;
  archived: number;
  starred: number;
  size: number;
  createdAt: number;
}

export interface MessageFull extends Omit<MessageSummary, "mailboxAddress"> {
  ccAddr: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  msgReferences: string | null;
  rawKey: string | null;
}

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
}

export interface MessageEvent {
  id: string;
  type: string;
  detail: string | null;
  createdAt: number;
}

export interface ThreadEntry {
  id: string;
  direction: "in" | "out";
  fromAddr: string;
  toAddr: string;
  subject: string;
  snippet: string;
  createdAt: number;
}

export interface Stats {
  totals: {
    total: number;
    inbound: number;
    outbound: number;
    unread: number;
    dmarcPass: number;
    needsReply: number;
    authChecked: number;
  };
  counts: {
    mailboxes: number;
    apiKeys: number;
    webhooks: number;
    templates: number;
    contacts: number;
    suppressions: number;
    users: number;
  };
  series: { day: string; inbound: number; outbound: number }[];
}

export interface RecordCheck {
  purpose: string;
  service: "routing" | "sending" | "policy";
  type: string;
  name: string;
  expected: string;
  found: string[];
  status: "ok" | "missing" | "mismatch";
}

export interface DomainStatus {
  domain: string;
  zoneId: string;
  checkedAt: number;
  summary: { ok: number; total: number; healthy: boolean };
  records: RecordCheck[];
}

export interface ApiKey {
  id: string;
  name: string;
  preview: string;
  scope: "full" | "sending";
  restrictMailboxId: string | null;
  lastUsedAt: number | null;
  createdAt: number;
  /** Present only in the create response. */
  plaintext?: string;
}

export interface Webhook {
  id: string;
  url: string;
  eventTypes: string;
  secret: string;
  enabled: number;
  createdAt: number;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventType: string;
  statusCode: number | null;
  error: string | null;
  durationMs: number | null;
  createdAt: number;
}

export interface Template {
  id: string;
  slug: string;
  name: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  /** Default sender, as a mailbox address. Empty means the send decides. */
  fromAddress: string;
  /** Default Reply-To. Empty falls through to the mailbox's own setting. */
  replyTo: string;
  /** Which tenant owns it; lets a duplicate land in the same one. */
  orgId?: string;
  /** Sanitised exactly as the send path would, so the preview cannot flatter. */
  previewHtml?: string | null;
  updatedAt: number;
  createdAt: number;
}

export interface TemplateVersion {
  id: string;
  templateId: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  fromAddress: string;
  replyTo: string;
  actorEmail: string;
  createdAt: number;
}

export interface Contact {
  id: string;
  email: string;
  name: string;
  company: string;
  notes: string;
  createdAt: number;
}

export interface Suppression {
  id: string;
  email: string;
  reason: "bounce" | "complaint" | "manual";
  detail: string;
  createdAt: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Which tenant a platform administrator is looking at.
 *
 * Sent on every request rather than threaded through each call site, so a page
 * added later cannot forget it and quietly read across tenants. The server
 * ignores it for anyone who is not a platform administrator, so it is a view
 * preference here, never a grant.
 */
const ORG_KEY = "mv_org";

export function activeOrg(): string {
  return localStorage.getItem(ORG_KEY) ?? "";
}

export function setActiveOrg(id: string): void {
  if (id) localStorage.setItem(ORG_KEY, id);
  else localStorage.removeItem(ORG_KEY);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const org = activeOrg();
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(org ? { "x-mittova-org": org } : {}),
      ...init?.headers,
    },
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await res.json() : null;
  if (!res.ok) throw new ApiError(payload?.error ?? `Request failed (${res.status})`, res.status);
  return payload as T;
}

const body = (v: unknown) => JSON.stringify(v);
const splitList = (s?: string) =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export interface Org {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  domains: string[];
  mailboxes: number;
  users: number;
  templates: number;
  /** Outbound messages per rolling 24h across the whole tenant; 0 is unlimited. */
  dailySendLimit: number;
}

export const api = {
  me: () => request<Me>("/auth/me"),
  orgs: () => request<Org[]>("/orgs"),
  createOrg: (name: string) => request<Org>("/orgs", { method: "POST", body: body({ name }) }),
  updateOrg: (id: string, patch: { name?: string; dailySendLimit?: number }) =>
    request<{ ok: true }>(`/orgs/${id}`, { method: "PATCH", body: body(patch) }),
  deleteOrg: (id: string) => request<{ ok: true }>(`/orgs/${id}`, { method: "DELETE" }),
  /**
   * Exports whichever tenant the caller is in, so it goes through the org
   * header like everything else rather than naming one.
   */
  exportUrl: () => "/api/export",
  login: (email: string | undefined, password: string) =>
    request<{ ok: true }>("/auth/login", { method: "POST", body: body({ email, password }) }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
  changePassword: (password: string) =>
    request<{ ok: true }>("/auth/password", { method: "POST", body: body({ password }) }),
  saveSignature: (signature: string) =>
    request<{ ok: true }>("/auth/signature", { method: "POST", body: body({ signature }) }),

  users: () => request<User[]>("/users"),
  invitePreview: (token: string) =>
    request<{ email: string; name: string }>(`/auth/invite/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, password: string) =>
    request<{ ok: true; email: string }>("/auth/accept", {
      method: "POST",
      body: body({ token, password }),
    }),
  reinvite: (id: string) =>
    request<{ inviteToken: string; email: string }>(`/users/${id}/invite`, { method: "POST" }),

  createUser: (u: {
    email: string;
    name: string;
    role: "owner" | "member";
    /** Omitted to invite instead, which is the default. */
    password?: string;
    mailboxIds: string[];
  }) => request<User & { inviteToken: string | null }>("/users", { method: "POST", body: body(u) }),
  updateUser: (
    id: string,
    patch: {
      name?: string;
      role?: "owner" | "member";
      disabled?: boolean;
      password?: string;
      mailboxIds?: string[];
    },
  ) => request<{ ok: true }>(`/users/${id}`, { method: "PATCH", body: body(patch) }),
  deleteUser: (id: string) => request<{ ok: true }>(`/users/${id}`, { method: "DELETE" }),

  stats: (days = 14) => request<Stats>(`/stats?days=${days}`),
  domains: (fresh = false) => request<DomainStatus[]>(`/domains${fresh ? "?fresh=1" : ""}`),
  addDomain: (domain: string, zoneId: string) =>
    request<{
      domain: string;
      zoneId: string;
      sending: { configured: boolean; error?: string };
      receiving: boolean;
    }>("/domains", {
      method: "POST",
      body: body({ domain, zoneId }),
    }),
  checkDomain: (domain: string) => request<DomainStatus>(`/domains/${encodeURIComponent(domain)}`),
  removeDomain: (domain: string) =>
    request<{ ok: true }>(`/domains/${encodeURIComponent(domain)}`, { method: "DELETE" }),

  mailboxes: () => request<Mailbox[]>("/mailboxes"),
  createMailbox: (
    address: string,
    name: string,
    dailySendLimit: number,
    domain?: string,
    replyTo?: string,
  ) =>
    request<Mailbox & { routing: { configured: boolean; ruleId?: string; error?: string } }>(
      "/mailboxes",
      { method: "POST", body: body({ address, name, dailySendLimit, domain, replyTo }) },
    ),
  updateMailbox: (
    id: string,
    patch: { name?: string; dailySendLimit?: number; replyTo?: string },
  ) => request<Mailbox>(`/mailboxes/${id}`, { method: "PATCH", body: body(patch) }),
  deleteMailbox: (id: string) => request<{ ok: true }>(`/mailboxes/${id}`, { method: "DELETE" }),

  messages: (p: {
    mailboxId?: string;
    direction?: string;
    q?: string;
    unread?: boolean;
    needsReply?: boolean;
    assigned?: "me" | "none";
    view?: "archived" | "starred";
    before?: number;
    limit?: number;
  }) => {
    const qs = new URLSearchParams();
    if (p.mailboxId) qs.set("mailboxId", p.mailboxId);
    if (p.direction) qs.set("direction", p.direction);
    if (p.q) qs.set("q", p.q);
    if (p.unread) qs.set("unread", "1");
    if (p.needsReply) qs.set("needsReply", "1");
    if (p.assigned) qs.set("assigned", p.assigned);
    if (p.view) qs.set("view", p.view);
    if (p.before) qs.set("before", String(p.before));
    if (p.limit) qs.set("limit", String(p.limit));
    return request<{ messages: MessageSummary[]; nextBefore: number | null }>(`/messages?${qs}`);
  },
  message: (id: string) =>
    request<{
      message: MessageFull;
      assignable: { id: string; name: string; email: string }[];
      attachments: Attachment[];
      events: MessageEvent[];
      thread: ThreadEntry[];
    }>(`/messages/${id}`),
  flag: (id: string, patch: { archived?: boolean; starred?: boolean }) =>
    request<{ ok: true }>(`/messages/${id}/flag`, { method: "POST", body: body(patch) }),
  assign: (id: string, userId: string | null) =>
    request<{ ok: true; assignedToUserId: string | null }>(`/messages/${id}/assign`, {
      method: "POST",
      body: body({ userId }),
    }),
  markUnread: (id: string) => request<{ ok: true }>(`/messages/${id}/unread`, { method: "POST" }),
  deleteMessage: (id: string) => request<{ ok: true }>(`/messages/${id}`, { method: "DELETE" }),

  send: (p: {
    mailboxId: string;
    to: string;
    cc?: string;
    bcc?: string;
    /** Optional: a template supplies one, and "" would beat it. */
    subject?: string;
    text?: string;
    html?: string;
    replyToMessageId?: string;
    template?: string;
    variables?: Record<string, string>;
    attachments?: { filename: string; content: string; type?: string }[];
  }) =>
    request<{ ok: true; id: string; messageId: string | null; sent24h: number }>("/send", {
      method: "POST",
      body: body({
        ...p,
        to: splitList(p.to),
        cc: splitList(p.cc),
        bcc: splitList(p.bcc),
      }),
    }),

  apiKeys: () => request<ApiKey[]>("/api-keys"),
  createApiKey: (name: string, scope: "full" | "sending", restrictMailboxId: string | null) =>
    request<ApiKey>("/api-keys", {
      method: "POST",
      body: body({ name, scope, restrictMailboxId }),
    }),
  deleteApiKey: (id: string) => request<{ ok: true }>(`/api-keys/${id}`, { method: "DELETE" }),

  webhooks: () => request<{ webhooks: Webhook[]; deliveries: WebhookDelivery[] }>("/webhooks"),
  createWebhook: (url: string, eventTypes: string[]) =>
    request<Webhook>("/webhooks", { method: "POST", body: body({ url, eventTypes }) }),
  updateWebhook: (id: string, patch: { enabled?: boolean; eventTypes?: string[] }) =>
    request<{ ok: true }>(`/webhooks/${id}`, { method: "PATCH", body: body(patch) }),
  deleteWebhook: (id: string) => request<{ ok: true }>(`/webhooks/${id}`, { method: "DELETE" }),

  templates: (withPreview = false) =>
    request<Template[]>(`/templates${withPreview ? "?preview=1" : ""}`),
  template: (id: string) => request<Template>(`/templates/${id}`),
  createTemplate: (t: {
    slug: string;
    name: string;
    subject: string;
    bodyText: string;
    bodyHtml?: string;
    fromAddress?: string;
    replyTo?: string;
  }) => request<Template>("/templates", { method: "POST", body: body(t) }),
  duplicateTemplate: (id: string) =>
    request<Template>(`/templates/${id}/duplicate`, { method: "POST" }),
  updateTemplate: (id: string, patch: Partial<Template>) =>
    request<Template>(`/templates/${id}`, { method: "PATCH", body: body(patch) }),
  deleteTemplate: (id: string) => request<{ ok: true }>(`/templates/${id}`, { method: "DELETE" }),
  templateVersions: (id: string) => request<TemplateVersion[]>(`/templates/${id}/versions`),
  restoreTemplateVersion: (id: string, versionId: string) =>
    request<Template>(`/templates/${id}/versions/${versionId}/restore`, { method: "POST" }),

  contacts: (q?: string) =>
    request<Contact[]>(`/contacts${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  createContact: (c: { email: string; name: string; company: string; notes: string }) =>
    request<Contact>("/contacts", { method: "POST", body: body(c) }),
  deleteContact: (id: string) => request<{ ok: true }>(`/contacts/${id}`, { method: "DELETE" }),

  drafts: () => request<Draft[]>("/drafts"),
  saveDraft: (
    id: string,
    d: {
      mailboxId: string;
      to: string;
      cc: string;
      bcc: string;
      subject: string;
      html: string;
      replyToMessageId?: string | null;
    },
  ) => request<Draft>(`/drafts/${id}`, { method: "PUT", body: body(d) }),
  deleteDraft: (id: string) => request<{ ok: true }>(`/drafts/${id}`, { method: "DELETE" }),

  audit: () => request<AuditEntry[]>("/audit"),
  backups: () => request<BackupObject[]>("/backups"),
  runBackup: () =>
    request<{ key: string; bytes: number; durationMs: number }>("/backups", { method: "POST" }),

  suppressions: () => request<Suppression[]>("/suppressions"),
  createSuppression: (email: string, reason: string, detail: string) =>
    request<Suppression>("/suppressions", {
      method: "POST",
      body: body({ email, reason, detail }),
    }),
  deleteSuppression: (id: string) =>
    request<{ ok: true }>(`/suppressions/${id}`, { method: "DELETE" }),
};
