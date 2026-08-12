/**
 * Cross-tenant isolation, tested against the live deployment with real accounts
 * rather than asserted from the diff.
 *
 * Sets up a second tenant with its own owner, then tries from that account to
 * reach the first tenant's data by every route the API exposes.
 */
import { readFileSync } from "node:fs";

/**
 * Configured from the environment rather than hardcoded, so this runs against
 * any deployment and carries no operator's URL, tenant or filesystem layout.
 *
 *   MITTOVA_URL=https://mail.example.com \
 *   MITTOVA_ADMIN_PASSWORD_FILE=~/.secrets/admin \
 *   MITTOVA_ORG_A=org_one.example MITTOVA_ORG_B=org_two.example \
 *   node scripts/tenant-isolation.mjs
 *
 * ORG_A is the tenant under attack; ORG_B is the one the probe account lives
 * in. Both must already exist, and ORG_A needs at least one mailbox and user
 * for the attacks to have a target.
 */
function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is required. See the comment at the top of this file.`);
    process.exit(2);
  }
  return v;
}

const BASE = required("MITTOVA_URL").replace(/\/$/, "");
const ADMIN_PW = (
  process.env.MITTOVA_ADMIN_PASSWORD ??
  readFileSync(required("MITTOVA_ADMIN_PASSWORD_FILE"), "utf8")
).trim();

async function session(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok)
    throw new Error(`login failed for ${email ?? "admin"}: ${res.status} ${await res.text()}`);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return async (path, init = {}, org) => {
    const r = await fetch(`${BASE}/api${path}`, {
      ...init,
      headers: {
        cookie,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(org ? { "x-mittova-org": org } : {}),
        ...init.headers,
      },
    });
    let body = null;
    try {
      body = await r.json();
    } catch {}
    return { status: r.status, body };
  };
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const admin = await session(undefined, ADMIN_PW);

// --- setup: a mailbox and an owner inside org B ------------------------------
const TF = required("MITTOVA_ORG_B");
const NX = required("MITTOVA_ORG_A");

const mbox = await admin(
  "/mailboxes",
  {
    method: "POST",
    body: JSON.stringify({
      address: "isolation",
      domain: TF.replace(/^org_/, ""),
      name: "Isolation Test",
    }),
  },
  TF,
);
console.log("setup mailbox:", mbox.status, mbox.body?.address ?? JSON.stringify(mbox.body));

const PW = "Tenant-Isolation-9271!";
const tfUser = await admin(
  "/users",
  {
    method: "POST",
    body: JSON.stringify({
      email: `isolation@${TF.replace(/^org_/, "")}`,
      name: "Isolation Owner",
      role: "owner",
      password: PW,
      mailboxIds: mbox.body?.id ? [mbox.body.id] : [],
    }),
  },
  TF,
);
console.log("setup user:", tfUser.status, tfUser.body?.email ?? JSON.stringify(tfUser.body));

// What org A actually has, seen by the admin, to target in the attacks.
const nxMailboxes = await admin("/mailboxes", {}, NX);
const victim = nxMailboxes.body?.[0];
console.log("victim mailbox:", victim?.address);

const nxUsers = await admin("/users", {}, NX);
const victimUser = nxUsers.body?.[0];
console.log("victim user:", victimUser?.email);
console.log("---");

// --- the actual test: sign in as org B's owner -------------------------------
const tf = await session(`isolation@${TF.replace(/^org_/, "")}`, PW);

const boxes = await tf("/mailboxes");
const addrs = (boxes.body ?? []).map((m) => m.address);
check(
  "sees only its own mailboxes",
  addrs.every((a) => a.endsWith(`@${TF.replace(/^org_/, "")}`)),
  addrs.join(", ") || "none",
);

const users = await tf("/users");
const emails = (users.body ?? []).map((u) => u.email);
check(
  "sees only its own users",
  emails.every((e) => e.endsWith(`@${TF.replace(/^org_/, "")}`)),
  emails.join(", ") || "none",
);

const doms = await tf("/domains");
const dl = (doms.body ?? []).map((d) => d.domain);
check(
  "sees only its own domains",
  dl.length === 1 && dl[0] === TF.replace(/^org_/, ""),
  dl.join(", ") || "none",
);

// The header is a view preference for platform admins, never a grant.
const spoof = await tf("/mailboxes", {}, NX);
const spoofed = (spoof.body ?? []).map((m) => m.address);
check(
  "org header cannot be used to cross over",
  spoofed.every((a) => a.endsWith(`@${TF.replace(/^org_/, "")}`)),
  spoofed.join(", ") || "none",
);

const readVictim = await tf(`/mailboxes/${victim?.id}`, {
  method: "PATCH",
  body: JSON.stringify({ name: "pwned" }),
});
check(
  "cannot rename another tenant's mailbox",
  readVictim.status === 404,
  `HTTP ${readVictim.status}`,
);

const delVictim = await tf(`/mailboxes/${victim?.id}`, { method: "DELETE" });
check(
  "cannot delete another tenant's mailbox",
  delVictim.status === 404,
  `HTTP ${delVictim.status}`,
);

const takeover = await tf(`/users/${victimUser?.id}`, {
  method: "PATCH",
  body: JSON.stringify({ password: "Attacker-Owns-You-1!" }),
});
check(
  "cannot reset another tenant's user password",
  takeover.status === 404,
  `HTTP ${takeover.status}`,
);

const delUser = await tf(`/users/${victimUser?.id}`, { method: "DELETE" });
check("cannot delete another tenant's user", delUser.status === 404, `HTTP ${delUser.status}`);

const grant = await tf(`/users/${tfUser.body?.id}`, {
  method: "PATCH",
  body: JSON.stringify({ mailboxIds: [victim?.id] }),
});
const after = await tf("/mailboxes");
const grantedAddrs = (after.body ?? []).map((m) => m.address);
check(
  "cannot grant itself another tenant's mailbox",
  !grantedAddrs.includes(victim?.address),
  `HTTP ${grant.status}, now sees ${grantedAddrs.join(", ") || "none"}`,
);

const sendAs = await tf("/send", {
  method: "POST",
  body: JSON.stringify({ mailboxId: victim?.id, to: ["x@example.com"], subject: "x", text: "x" }),
});
check("cannot send as another tenant's mailbox", sendAs.status === 403, `HTTP ${sendAs.status}`);

const backup = await tf("/backups");
check("cannot list backups (spans every tenant)", backup.status === 403, `HTTP ${backup.status}`);

const runBackup = await tf("/backups", { method: "POST" });
check("cannot take a backup", runBackup.status === 403, `HTTP ${runBackup.status}`);

const orgs = await tf("/orgs");
check("cannot enumerate tenants", orgs.status === 403, `HTTP ${orgs.status}`);

// A platform administrator acting inside the tenant legitimately appears as an
// actor — that is the point of the trail. What must not appear is any entry
// about another tenant's data.
const audit = await tf("/audit");
const leaked = (audit.body ?? []).filter(
  (a) => a.target?.includes(NX.replace(/^org_/, "")) || a.detail?.includes(NX.replace(/^org_/, "")),
);
check(
  "audit carries no other tenant's actions",
  leaked.length === 0,
  `${audit.body?.length ?? 0} entries, ${leaked.length} referencing another tenant`,
);

const msgs = await tf("/messages");
const mboxes2 = [...new Set((msgs.body?.messages ?? []).map((m) => m.mailboxAddress))];
check(
  "sees no other tenant's messages",
  mboxes2.every((a) => a.endsWith(`@${TF.replace(/^org_/, "")}`)),
  mboxes2.join(", ") || "none",
);

const search = await tf("/messages?q=the");
const found = [...new Set((search.body?.messages ?? []).map((m) => m.mailboxAddress))];
check(
  "search respects the boundary",
  found.every((a) => a.endsWith(`@${TF.replace(/^org_/, "")}`)),
  found.join(", ") || "none",
);

console.log("---");
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} passed`);

// --- teardown ---------------------------------------------------------------
if (tfUser.body?.id) await admin(`/users/${tfUser.body.id}`, { method: "DELETE" }, TF);
if (mbox.body?.id) await admin(`/mailboxes/${mbox.body.id}`, { method: "DELETE" }, TF);
console.log("cleaned up");
process.exit(failed.length ? 1 : 0);
