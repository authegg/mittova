/**
 * Domain health for the Domains page.
 *
 * Deliberately resolved over public DNS-over-HTTPS rather than the Cloudflare
 * API: it needs no credentials in the Worker, and it reports what receiving
 * mail servers actually see, which is the thing that decides deliverability.
 */

interface DohAnswer {
  name: string;
  type: number;
  data: string;
}

const RECORD_TYPES: Record<string, number> = { A: 1, CNAME: 5, MX: 15, TXT: 16 };

async function resolve(name: string, type: keyof typeof RECORD_TYPES): Promise<string[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
  try {
    const res = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { Answer?: DohAnswer[] };
    return (
      (body.Answer ?? [])
        .filter((a) => a.type === RECORD_TYPES[type])
        // TXT answers come back quoted, and long ones arrive split into chunks.
        .map((a) => a.data.replace(/^"|"$/g, "").replace(/" "/g, ""))
    );
  } catch {
    return [];
  }
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
  checkedAt: number;
  summary: { ok: number; total: number; healthy: boolean };
  records: RecordCheck[];
}

function judge(found: string[], matches: (v: string) => boolean): RecordCheck["status"] {
  if (found.length === 0) return "missing";
  return found.some(matches) ? "ok" : "mismatch";
}

import { eq } from "drizzle-orm";
import { domains as domainsTable, organizations } from "../db/schema";
import type { Db } from "../db/types";

export interface ConfiguredDomain {
  domain: string;
  /** Zone that owns this domain, for Email Routing rule management. */
  zoneId: string;
  /** Tenant this domain belongs to. */
  orgId: string;
}

/**
 * Parse MAIL_DOMAIN, which lists one or more domains and optionally the zone
 * that owns each: "a.com:zoneA,b.com:zoneB". A bare domain falls back to
 * CF_ZONE_ID, which is right for the single-domain case.
 *
 * Domain and zone must travel together: routing rules are created per zone, and
 * keying them off a single CF_ZONE_ID silently files every domain's rules under
 * the first zone.
 */
export function configuredDomains(value: string, fallbackZoneId = ""): ConfiguredDomain[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [domain, zoneId] = entry.split(":");
      return {
        domain: domain.trim().toLowerCase(),
        zoneId: (zoneId ?? fallbackZoneId).trim(),
        orgId: "",
      };
    })
    .filter((d) => d.domain);
}

/** Stable, readable org id for a domain, matching what the migration seeded. */
export function orgIdForDomain(domain: string): string {
  return `org_${domain.trim().toLowerCase()}`;
}

/**
 * The domains this deployment serves.
 *
 * Database first so the dashboard can add one without a redeploy; MAIL_DOMAIN
 * seeds the table on a fresh install so a new deployment works before anyone
 * opens the UI.
 */
export async function listDomains(db: Db, env: Env, orgId?: string): Promise<ConfiguredDomain[]> {
  // Creation order, so the list is stable: the domain you started with stays at
  // the top and new ones append, rather than the page reshuffling alphabetically
  // every time a domain is added.
  const rows = await db.select().from(domainsTable).orderBy(domainsTable.createdAt).all();
  if (rows.length > 0) {
    // Undefined means every domain, which is what address-level lookups want:
    // resolving the zone for an inbound address is not a tenant question.
    const scoped = orgId === undefined ? rows : rows.filter((r) => r.orgId === orgId);
    return scoped.map((r) => ({ domain: r.domain, zoneId: r.zoneId, orgId: r.orgId }));
  }

  // Fresh install: seed a domain and the org that owns it together, so there is
  // never a domain belonging to no tenant.
  const seed = configuredDomains(env.MAIL_DOMAIN, env.CF_ZONE_ID).map((d) => ({
    ...d,
    orgId: orgIdForDomain(d.domain),
  }));
  if (seed.length > 0) {
    const now = Date.now();
    await db
      .insert(organizations)
      .values(
        seed.map((d) => ({
          id: d.orgId,
          name: d.domain,
          slug: d.domain.replace(/\./g, "-"),
          createdAt: now,
        })),
      )
      .onConflictDoNothing();
    await db
      .insert(domainsTable)
      .values(
        seed.map((d) => ({
          id: crypto.randomUUID(),
          domain: d.domain,
          zoneId: d.zoneId,
          orgId: d.orgId,
          createdAt: now,
        })),
      )
      .onConflictDoNothing();
  }
  return seed;
}

/** Zone that owns an address's domain, or "" when it is not configured. */
export async function zoneForAddress(db: Db, env: Env, address: string): Promise<string> {
  const domain = address.split("@")[1]?.toLowerCase() ?? "";
  return (await listDomains(db, env)).find((d) => d.domain === domain)?.zoneId ?? "";
}

/**
 * Add a domain to a tenant.
 *
 * An empty orgId means "give this domain its own org", which is how a platform
 * administrator onboards a new client in one step: the org is created here
 * rather than being a separate thing to remember.
 */
export async function addDomain(
  db: Db,
  domain: string,
  zoneId: string,
  orgId: string,
): Promise<ConfiguredDomain> {
  const name = domain.trim().toLowerCase();
  const now = Date.now();
  const owner = orgId || orgIdForDomain(name);

  if (!orgId) {
    await db
      .insert(organizations)
      .values({ id: owner, name, slug: name.replace(/\./g, "-"), createdAt: now })
      .onConflictDoNothing();
  }

  const row = {
    id: crypto.randomUUID(),
    domain: name,
    zoneId: zoneId.trim(),
    orgId: owner,
    createdAt: now,
  };
  await db.insert(domainsTable).values(row);
  return { domain: row.domain, zoneId: row.zoneId, orgId: owner };
}

/** Every tenant, oldest first. */
export async function listOrgs(db: Db) {
  return db.select().from(organizations).orderBy(organizations.createdAt).all();
}

/** Record a zone id discovered after the domain was added. */
export async function setZoneId(db: Db, domain: string, zoneId: string): Promise<void> {
  await db
    .update(domainsTable)
    .set({ zoneId })
    .where(eq(domainsTable.domain, domain.trim().toLowerCase()));
}

export async function removeDomain(db: Db, domain: string): Promise<void> {
  await db.delete(domainsTable).where(eq(domainsTable.domain, domain.trim().toLowerCase()));
}

export async function checkDomain(domain: string): Promise<DomainStatus> {
  const bounce = `cf-bounce.${domain}`;

  const [apexMx, apexSpf, routingDkim, bounceMx, bounceSpf, sendingDkim, dmarc] = await Promise.all(
    [
      resolve(domain, "MX"),
      resolve(domain, "TXT"),
      resolve(`cf2024-1._domainkey.${domain}`, "TXT"),
      resolve(bounce, "MX"),
      resolve(bounce, "TXT"),
      resolve(`cf-bounce._domainkey.${domain}`, "TXT"),
      resolve(`_dmarc.${domain}`, "TXT"),
    ],
  );

  const isCloudflareMx = (v: string) => /route\d\.mx\.cloudflare\.net/i.test(v);
  const isCloudflareSpf = (v: string) =>
    v.startsWith("v=spf1") && v.includes("_spf.mx.cloudflare.net");
  const isDkim = (v: string) => v.startsWith("v=DKIM1");

  const records: RecordCheck[] = [
    {
      purpose: "Inbound mail routed to Cloudflare",
      service: "routing",
      type: "MX",
      name: domain,
      expected: "route1/2/3.mx.cloudflare.net",
      found: apexMx,
      status: judge(apexMx, isCloudflareMx),
    },
    {
      purpose: "Authorises Cloudflare to send for the domain",
      service: "routing",
      type: "TXT",
      name: domain,
      expected: "v=spf1 include:_spf.mx.cloudflare.net ~all",
      found: apexSpf.filter((v) => v.startsWith("v=spf1")),
      status: judge(apexSpf, isCloudflareSpf),
    },
    {
      purpose: "Signs forwarded mail",
      service: "routing",
      type: "TXT",
      name: `cf2024-1._domainkey.${domain}`,
      expected: "v=DKIM1; ...",
      found: routingDkim,
      status: judge(routingDkim, isDkim),
    },
    {
      purpose: "Bounce processing for outbound mail",
      service: "sending",
      type: "MX",
      name: bounce,
      expected: "route1/2/3.mx.cloudflare.net",
      found: bounceMx,
      status: judge(bounceMx, isCloudflareMx),
    },
    {
      purpose: "SPF for the sending return path",
      service: "sending",
      type: "TXT",
      name: bounce,
      expected: "v=spf1 include:_spf.mx.cloudflare.net ~all",
      found: bounceSpf.filter((v) => v.startsWith("v=spf1")),
      status: judge(bounceSpf, isCloudflareSpf),
    },
    {
      purpose: "Signs outbound mail",
      service: "sending",
      type: "TXT",
      name: `cf-bounce._domainkey.${domain}`,
      expected: "v=DKIM1; ...",
      found: sendingDkim,
      status: judge(sendingDkim, isDkim),
    },
    {
      purpose: "Tells receivers what to do when auth fails",
      service: "policy",
      type: "TXT",
      name: `_dmarc.${domain}`,
      expected: "v=DMARC1; p=quarantine; rua=...",
      found: dmarc.filter((v) => v.startsWith("v=DMARC1")),
      status: judge(dmarc, (v) => v.startsWith("v=DMARC1")),
    },
  ];

  const ok = records.filter((r) => r.status === "ok").length;
  return {
    domain,
    checkedAt: Date.now(),
    summary: { ok, total: records.length, healthy: ok === records.length },
    records,
  };
}
