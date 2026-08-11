/**
 * R2 key layout.
 *
 * One bucket, `mittova`, holds everything the app stores. Message content is
 * namespaced by domain so per-domain lifecycle rules, exports and deletes are
 * prefix operations rather than full scans. Backups sit alongside under a
 * reserved prefix, since they span every domain and belong to no single one.
 *
 * Keys are built here rather than concatenated at each call site, so the layout
 * can change in one place. Reads always use the key stored on the row, never a
 * recomputed one, so a layout change cannot orphan existing objects.
 *
 *   <domain>/raw/<mailboxId>/<messageId>.eml   raw MIME, inbound only
 *   <domain>/att/<messageId>/<attachmentId>    attachment bytes
 *   _backups/<date>/<timestamp>.ndjson         database export
 *
 * The leading underscore keeps backups out of the domain namespace: no domain
 * can collide with it, so `list({ prefix: "example.com/" })` never sweeps them
 * up.
 */

export const BACKUP_PREFIX = "_backups/";

/** Domain part of an address, lowercased. Falls back to a bucket for oddities. */
export function domainOf(address: string): string {
  return address.split("@")[1]?.trim().toLowerCase() || "_unknown";
}

/** Everything belonging to one domain, for lifecycle rules and bulk deletes. */
export function domainPrefix(address: string): string {
  return `${domainOf(address)}/`;
}

export function rawKey(address: string, mailboxId: string, messageId: string): string {
  return `${domainPrefix(address)}raw/${mailboxId}/${messageId}.eml`;
}

export function attachmentKey(address: string, messageId: string, attachmentId: string): string {
  return `${domainPrefix(address)}att/${messageId}/${attachmentId}`;
}

export function backupKey(at: Date): string {
  const iso = at.toISOString();
  return `${BACKUP_PREFIX}${iso.slice(0, 10)}/mittova-${iso.replace(/[:.]/g, "-")}.ndjson`;
}
