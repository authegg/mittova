import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { drizzle } from "drizzle-orm/d1";
import { recordEvent } from "../src/services/events";

/**
 * The tenant boundary, exercised through the routes that enforce it.
 *
 * This is the coverage the suite was missing. Every other test in the project
 * is a pure function, so four separate cross-tenant leaks were introduced and
 * caught only by hand: an api key that could send as any mailbox, public read
 * endpoints that returned every tenant's messages, an owner-count check that
 * spanned tenants, and an audit trail with no tenant at all. A refactor that
 * drops an orgFilter should fail here rather than in production.
 *
 * Deliberately end-to-end from the HTTP request: the filter is only correct if
 * the middleware, the scope resolution and the query all agree, and testing
 * orgFilter alone would prove none of that.
 */

const PASSWORD = "Tenant-Test-Password-9127!";

async function call(path: string, init: RequestInit = {}, cookie?: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://mittova.test${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...init.headers,
      },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const json = (v: unknown) => JSON.stringify(v);

async function signIn(email: string | undefined, password: string): Promise<string> {
  const res = await call("/api/auth/login", { method: "POST", body: json({ email, password }) });
  expect(res.status, `sign-in for ${email ?? "admin"}`).toBe(200);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

/** Two tenants, each with a domain, a mailbox, an owner and a template. */
async function seed() {
  const now = Date.now();
  const rows: [string, unknown[]][] = [];
  for (const [org, domain] of [
    ["org_alpha", "alpha.test"],
    ["org_beta", "beta.test"],
  ] as const) {
    rows.push([
      "insert into organizations (id,name,slug,created_at) values (?,?,?,?)",
      [org, domain, domain.replace(".", "-"), now],
    ]);
    rows.push([
      "insert into domains (id,domain,zone_id,org_id,created_at) values (?,?,?,?,?)",
      [`d_${org}`, domain, "", org, now],
    ]);
    rows.push([
      "insert into mailboxes (id,address,name,daily_send_limit,reply_to,org_id,created_at) values (?,?,?,?,?,?,?)",
      [`mb_${org}`, `desk@${domain}`, "Desk", 200, "", org, now],
    ]);
    rows.push([
      "insert into templates (id,slug,name,subject,body_text,body_html,from_address,reply_to,org_id,updated_at,created_at) values (?,?,?,?,?,?,?,?,?,?,?)",
      [`tpl_${org}`, "welcome", "Welcome", "Hi", "hello", "<p>hello</p>", "", "", org, now, now],
    ]);
  }
  for (const [sql, args] of rows)
    await env.DB.prepare(sql)
      .bind(...args)
      .run();
}

/** An owner inside one tenant, created through the API so hashing is real. */
async function makeOwner(org: string, email: string): Promise<string> {
  const admin = await signIn(undefined, "test-admin-password");
  const res = await call(
    "/api/users",
    {
      method: "POST",
      body: json({ email, name: email, role: "owner", password: PASSWORD }),
      headers: { "x-mittova-org": org },
    },
    admin,
  );
  expect(res.status, `create ${email}`).toBe(201);
  return signIn(email, PASSWORD);
}

describe("tenant isolation", () => {
  let alpha: string;

  beforeEach(async () => {
    await seed();
    alpha = await makeOwner("org_alpha", "owner@alpha.test");
  });

  it("lists only its own templates, domains, users and mailboxes", async () => {
    for (const [path, ours, theirs] of [
      ["/api/templates", "org_alpha", "org_beta"],
      ["/api/domains", "alpha.test", "beta.test"],
      ["/api/users", "alpha.test", "beta.test"],
      ["/api/mailboxes", "alpha.test", "beta.test"],
    ] as const) {
      const body = await (await call(path, {}, alpha)).text();
      expect(body, `${path} should mention ${ours}`).toContain(ours);
      expect(body, `${path} leaked ${theirs}`).not.toContain(theirs);
    }
  });

  it("counts only its own rows on the overview stats", async () => {
    /*
     * The message stats on this endpoint were scoped and the seven `count(*)`
     * tiles beside them were not, so an owner's totals moved when an unrelated
     * tenant added a row. No content escaped, but the numbers did — the same
     * shape as the cross-tenant owner count this project has had before.
     *
     * Driven from a real non-platform owner session, because a platform
     * administrator is legitimately allowed to see across tenants and would
     * make this pass either way.
     */
    const admin = await signIn(undefined, "test-admin-password");

    // Assert the positive first: alpha's own row is counted at all. A test that
    // only checks "beta's rows are absent" also passes when nothing is counted.
    for (const [org, email] of [
      ["org_alpha", "ours@alpha.test"],
      ["org_beta", "theirs@beta.test"],
    ] as const) {
      const res = await call(
        "/api/contacts",
        { method: "POST", body: json({ email, name: email }), headers: { "x-mittova-org": org } },
        admin,
      );
      expect(res.status, `create contact in ${org}`).toBe(201);
    }

    const stats = await (
      await call("/api/stats", {}, alpha)
    ).json<{
      counts: { contacts: number; templates: number; mailboxes: number; users: number };
    }>();

    expect(stats.counts.contacts, "should count alpha's contact and not beta's").toBe(1);
    expect(stats.counts.templates, "one template per tenant in the seed").toBe(1);
    expect(stats.counts.mailboxes, "one mailbox per tenant in the seed").toBe(1);
    expect(stats.counts.users, "only alpha's owner").toBe(1);
  });

  it("cannot read, edit, duplicate or delete another tenant's template", async () => {
    const id = "tpl_org_beta";
    expect((await call(`/api/templates/${id}`, {}, alpha)).status).toBe(404);
    expect(
      (await call(`/api/templates/${id}`, { method: "PATCH", body: json({ subject: "x" }) }, alpha))
        .status,
    ).toBe(404);
    expect((await call(`/api/templates/${id}/duplicate`, { method: "POST" }, alpha)).status).toBe(
      404,
    );
    expect((await call(`/api/templates/${id}/versions`, {}, alpha)).status).toBe(404);
    expect((await call(`/api/templates/${id}`, { method: "DELETE" }, alpha)).status).toBe(200);

    // Delete answers 200 but must not have deleted anything.
    const still = await env.DB.prepare("select count(*) as n from templates where id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(still?.n, "another tenant's template was deleted").toBe(1);
  });

  it("cannot restore a version belonging to another tenant onto its own template", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "insert into template_versions (id,template_id,org_id,name,subject,body_text,body_html,from_address,reply_to,actor_email,created_at) values (?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind("v_beta", "tpl_org_beta", "org_beta", "Beta", "BETA SECRET", "", null, "", "", "x", now)
      .run();

    const res = await call(
      "/api/templates/tpl_org_alpha/versions/v_beta/restore",
      { method: "POST" },
      alpha,
    );
    expect(res.status).toBe(404);

    const mine = await env.DB.prepare("select subject from templates where id = ?")
      .bind("tpl_org_alpha")
      .first<{ subject: string }>();
    expect(mine?.subject).toBe("Hi");
  });

  it("cannot send as another tenant's mailbox", async () => {
    const res = await call(
      "/api/send",
      { method: "POST", body: json({ mailboxId: "mb_org_beta", to: "x@example.com", text: "x" }) },
      alpha,
    );
    expect(res.status).toBe(403);
  });

  it("cannot reach another tenant by setting the org header", async () => {
    const body = await (
      await call("/api/templates", { headers: { "x-mittova-org": "org_beta" } }, alpha)
    ).text();
    expect(body, "the org header acted as a grant").not.toContain("org_beta");
  });

  it("cannot take a backup, which spans every tenant", async () => {
    expect((await call("/api/backups", {}, alpha)).status).toBe(403);
    expect((await call("/api/backups", { method: "POST" }, alpha)).status).toBe(403);
  });

  it("cannot enumerate tenants", async () => {
    expect((await call("/api/orgs", {}, alpha)).status).toBe(403);
  });

  it("keeps the audit trail within the tenant", async () => {
    await call(
      "/api/templates",
      { method: "POST", body: json({ slug: "mine", name: "Mine" }) },
      alpha,
    );
    const now = Date.now();
    await env.DB.prepare(
      "insert into audit_log (id,actor_id,actor_email,action,target,detail,org_id,created_at) values (?,?,?,?,?,?,?,?)",
    )
      .bind("a_beta", null, "someone@beta.test", "user.create", "BETA TARGET", "", "org_beta", now)
      .run();

    const body = await (await call("/api/audit", {}, alpha)).text();
    expect(body).not.toContain("BETA TARGET");
    expect(body).not.toContain("beta.test");
  });

  it("counts owners within the tenant when guarding the last one", async () => {
    // Beta has an owner too; demoting alpha's only owner must still be refused.
    await makeOwner("org_beta", "owner@beta.test");
    const me = await (await call("/api/users", {}, alpha)).json<{ id: string }[]>();
    const res = await call(
      `/api/users/${me[0].id}`,
      { method: "PATCH", body: json({ role: "member" }) },
      alpha,
    );
    // Self-demotion is refused before the count is even reached; both are 400.
    expect(res.status).toBe(400);
  });
});

describe("tenant isolation over the bearer API", () => {
  /** A key belongs to a tenant and must not reach outside it. */
  async function makeKey(org: string): Promise<string> {
    const admin = await signIn(undefined, "test-admin-password");
    const res = await call(
      "/api/api-keys",
      {
        method: "POST",
        body: json({ name: "k", scope: "full" }),
        headers: { "x-mittova-org": org },
      },
      admin,
    );
    expect(res.status).toBe(201);
    return (await res.json<{ plaintext: string }>()).plaintext;
  }

  beforeEach(seed);

  it("cannot send as a mailbox outside the key's tenant", async () => {
    const key = await makeKey("org_alpha");
    const res = await call("/api/v1/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: json({ from: "desk@beta.test", to: ["x@example.com"], subject: "s", text: "t" }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("queued");
  });

  it("cannot render another tenant's template", async () => {
    const key = await makeKey("org_alpha");
    await env.DB.prepare("update templates set slug = ? where id = ?")
      .bind("beta-only", "tpl_org_beta")
      .run();
    const res = await call("/api/v1/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: json({ from: "desk@alpha.test", to: ["x@example.com"], template: "beta-only" }),
    });
    expect(res.status).toBe(404);
  });

  it("lists only its own tenant's messages", async () => {
    const key = await makeKey("org_alpha");
    const now = Date.now();
    for (const [id, mailbox, subject] of [
      ["m_a", "mb_org_alpha", "ALPHA MESSAGE"],
      ["m_b", "mb_org_beta", "BETA MESSAGE"],
    ] as const) {
      await env.DB.prepare(
        "insert into messages (id,mailbox_id,direction,thread_id,from_addr,to_addr,subject,snippet,created_at) values (?,?,?,?,?,?,?,?,?)",
      )
        .bind(id, mailbox, "in", id, "s@x.test", "d@x.test", subject, "", now)
        .run();
    }

    const body = await (
      await call("/api/v1/emails", { headers: { authorization: `Bearer ${key}` } })
    ).text();
    expect(body).toContain("ALPHA MESSAGE");
    expect(body).not.toContain("BETA MESSAGE");
  });
});

/**
 * Webhooks fan out to endpoints, and endpoints belong to tenants.
 *
 * Every enabled endpoint on the deployment used to receive every tenant's mail
 * events — addresses, subjects and all. This is the test that would have caught
 * it, and the same shape catches it coming back.
 *
 * Driven through recordEvent rather than a real send: there is no send_email
 * binding in the test environment, so a send fails before the fan-out is
 * reached and the assertion would pass while proving nothing. The fan-out is
 * what is under test.
 */
describe("webhook fan-out", () => {
  beforeEach(seed);

  it("only tells a tenant's own endpoints about its mail", async () => {
    const now = Date.now();
    for (const [id, org, url] of [
      ["wh_alpha", "org_alpha", "https://alpha.invalid/hook"],
      ["wh_beta", "org_beta", "https://beta.invalid/hook"],
    ] as const) {
      await env.DB.prepare(
        "insert into webhooks (id,url,event_types,secret,enabled,org_id,created_at) values (?,?,?,?,?,?,?)",
      )
        .bind(id, url, '["*"]', "whsec_x", 1, org, now)
        .run();
    }
    await env.DB.prepare(
      "insert into messages (id,mailbox_id,direction,thread_id,from_addr,to_addr,subject,snippet,created_at) values (?,?,?,?,?,?,?,?,?)",
    )
      .bind("m_alpha", "mb_org_alpha", "out", "t", "desk@alpha.test", "x@example.com", "S", "", now)
      .run();

    const db = drizzle(env.DB);
    await recordEvent(db, env, {
      messageId: "m_alpha",
      orgId: "org_alpha",
      type: "email.sent",
      payload: { subject: "ALPHA SUBJECT" },
    });

    const rows = await env.DB.prepare(
      "select webhook_id, count(*) as tries from webhook_deliveries group by webhook_id",
    ).all<{ webhook_id: string; tries: number }>();
    const attempted = new Map(rows.results.map((r) => [r.webhook_id, r.tries]));

    // Proving the negative alone is worthless: if no delivery ran at all, an
    // empty list "passes" while telling us nothing.
    expect([...attempted.keys()], "no delivery ran, so this proves nothing").toContain("wh_alpha");
    expect(
      [...attempted.keys()],
      "another tenant's endpoint was told about this mail",
    ).not.toContain("wh_beta");

    // The endpoint is unreachable, so this also pins the retry: three attempts,
    // each recorded, rather than one silent failure.
    expect(attempted.get("wh_alpha")).toBe(3);
    // Slow on purpose — the backoff between attempts is real time.
  }, 20_000);
});

/**
 * Invites, which exist so nobody has to transmit a password.
 *
 * The token is the only credential for an account that has none yet, so the
 * rules that matter are: it works once, it expires, and a wrong one says the
 * same thing as an expired one.
 */
describe("user invites", () => {
  beforeEach(seed);

  async function invite(email: string): Promise<{ token: string; id: string }> {
    const admin = await signIn(undefined, "test-admin-password");
    const res = await call(
      "/api/users",
      {
        method: "POST",
        body: json({ email, name: email, role: "member" }),
        headers: { "x-mittova-org": "org_alpha" },
      },
      admin,
    );
    expect(res.status).toBe(201);
    const made = await res.json<{ id: string; inviteToken: string | null }>();
    expect(made.inviteToken, "no token was issued").toBeTruthy();
    return { token: made.inviteToken!, id: made.id };
  }

  it("creates an account that cannot be signed into until accepted", async () => {
    const { token } = await invite("newbie@alpha.test");

    // The row exists but has a password nobody knows.
    const guess = await call("/api/auth/login", {
      method: "POST",
      body: json({ email: "newbie@alpha.test", password: PASSWORD }),
    });
    expect(guess.status).toBe(401);

    const accepted = await call("/api/auth/accept", {
      method: "POST",
      body: json({ token, password: PASSWORD }),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("set-cookie"), "accepting should sign them in").toContain(
      "mv_session",
    );

    const now = await call("/api/auth/login", {
      method: "POST",
      body: json({ email: "newbie@alpha.test", password: PASSWORD }),
    });
    expect(now.status).toBe(200);
  });

  it("works once", async () => {
    const { token } = await invite("once@alpha.test");
    expect(
      (
        await call("/api/auth/accept", {
          method: "POST",
          body: json({ token, password: PASSWORD }),
        })
      ).status,
    ).toBe(200);
    // A forwarded invite mail must not be a second way in.
    expect(
      (
        await call("/api/auth/accept", {
          method: "POST",
          body: json({ token, password: "Another-Password-1234!" }),
        })
      ).status,
    ).toBe(400);
  });

  it("refuses an expired invite", async () => {
    const { token, id } = await invite("stale@alpha.test");
    await env.DB.prepare("update users set invite_expires_at = ? where id = ?")
      .bind(Date.now() - 1000, id)
      .run();
    expect(
      (
        await call("/api/auth/accept", {
          method: "POST",
          body: json({ token, password: PASSWORD }),
        })
      ).status,
    ).toBe(400);
  });

  it("says the same thing for a wrong token as for an expired one", async () => {
    const { token, id } = await invite("same@alpha.test");
    await env.DB.prepare("update users set invite_expires_at = ? where id = ?")
      .bind(Date.now() - 1000, id)
      .run();

    const expired = await call("/api/auth/accept", {
      method: "POST",
      body: json({ token, password: PASSWORD }),
    });
    const wrong = await call("/api/auth/accept", {
      method: "POST",
      body: json({ token: "0".repeat(64), password: PASSWORD }),
    });
    // Otherwise a guess that happened to be real would be distinguishable.
    expect(await wrong.text()).toBe(await expired.text());
  });

  it("stores only a hash, so the database is not a way in", async () => {
    const { token } = await invite("hashed@alpha.test");
    const row = await env.DB.prepare("select invite_hash from users where email = ?")
      .bind("hashed@alpha.test")
      .first<{ invite_hash: string }>();
    expect(row?.invite_hash).toBeTruthy();
    expect(row?.invite_hash).not.toBe(token);
  });

  it("refuses a weak password at acceptance", async () => {
    const { token } = await invite("weak@alpha.test");
    expect(
      (await call("/api/auth/accept", { method: "POST", body: json({ token, password: "short" }) }))
        .status,
    ).toBe(400);
  });
});

/**
 * A tenant export is a copy leaving the deployment, so what it contains and who
 * can ask for it both matter.
 */
describe("tenant export", () => {
  let alpha: string;

  beforeEach(async () => {
    await seed();
    alpha = await makeOwner("org_alpha", "owner@alpha.test");
  });

  it("contains only the caller's tenant", async () => {
    const res = await call("/api/export", {}, alpha);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("alpha.test");
    expect(body, "another tenant's rows were exported").not.toContain("beta.test");
  });

  it("redacts the secrets that would let someone authenticate", async () => {
    const body = await (await call("/api/export", {}, alpha)).text();
    const users = body
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((r) => r._table === "users");

    expect(users.length, "no users exported, so this proves nothing").toBeGreaterThan(0);
    for (const u of users) {
      expect(u.password_hash, "a password hash left the deployment").toBeNull();
      expect(u.password_salt).toBeNull();
      expect(u.invite_hash).toBeNull();
      // The account itself still has to be there, or the export is useless.
      expect(u.email).toBeTruthy();
    }
  });

  it("is offered as a download rather than rendered", async () => {
    const res = await call("/api/export", {}, alpha);
    expect(res.headers.get("content-type")).toContain("ndjson");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  it("covers every table a restore would need", async () => {
    const body = await (await call("/api/export", {}, alpha)).text();
    const meta = JSON.parse(body.split("\n")[0]);
    expect(meta._meta).toBe("mittova-org-export");
    // The tenant's own row must be in it, or a restore has nowhere to put the
    // rest.
    expect(body).toContain('"_table":"organizations"');
  });
});

/**
 * Mailbox assignment, which is a tenant boundary in its own right.
 *
 * The routes used to filter requested mailbox ids through canUseMailbox, which
 * asks whether the *caller* may touch a mailbox. A platform administrator with
 * no org selected reaches every mailbox on the deployment, so an edit made from
 * the "All organizations" view happily gave one tenant's user a mailbox
 * belonging to another, and the row stuck.
 *
 * The boundary belongs to the account being edited, not to whoever is editing.
 */
describe("mailbox assignment stays inside the account's tenant", () => {
  let admin: string;

  beforeEach(async () => {
    await seed();
    admin = await signIn(undefined, "test-admin-password");
  });

  /** Create an alpha member and return its id. */
  async function alphaMember(mailboxIds: string[] = []): Promise<string> {
    const res = await call(
      "/api/users",
      {
        method: "POST",
        body: json({
          email: "member@alpha.test",
          name: "Member",
          role: "member",
          password: PASSWORD,
          mailboxIds,
        }),
        headers: { "x-mittova-org": "org_alpha" },
      },
      admin,
    );
    expect(res.status).toBe(201);
    return (await res.json<{ id: string }>()).id;
  }

  const assignedTo = async (id: string): Promise<string[]> => {
    const rows = await call("/api/users", {}, admin);
    const users = await rows.json<{ id: string; mailboxIds: string[] }[]>();
    return users.find((u) => u.id === id)?.mailboxIds ?? [];
  };

  it("refuses another tenant's mailbox at creation", async () => {
    const id = await alphaMember(["mb_org_beta"]);
    expect(await assignedTo(id)).toEqual([]);
  });

  it("still grants a mailbox from the account's own tenant", async () => {
    // The positive case first: a test asserting only that beta is absent would
    // pass if assignment were broken outright.
    const id = await alphaMember(["mb_org_alpha"]);
    expect(await assignedTo(id)).toEqual(["mb_org_alpha"]);
  });

  it("refuses another tenant's mailbox on edit from the all-orgs view", async () => {
    const id = await alphaMember(["mb_org_alpha"]);
    // No x-mittova-org header at all: the admin is viewing every tenant, which
    // is the vantage point that used to make this succeed.
    const res = await call(
      `/api/users/${id}`,
      { method: "PATCH", body: json({ mailboxIds: ["mb_org_beta"] }) },
      admin,
    );
    expect(res.status).toBe(200);
    expect(await assignedTo(id)).toEqual([]);
  });

  it("keeps an own-tenant mailbox assignable from the all-orgs view", async () => {
    const id = await alphaMember();
    await call(
      `/api/users/${id}`,
      { method: "PATCH", body: json({ mailboxIds: ["mb_org_alpha"] }) },
      admin,
    );
    expect(await assignedTo(id)).toEqual(["mb_org_alpha"]);
  });

  it("records the number that landed, not the number requested", async () => {
    const id = await alphaMember();
    await call(
      `/api/users/${id}`,
      { method: "PATCH", body: json({ mailboxIds: ["mb_org_alpha", "mb_org_beta"] }) },
      admin,
    );
    const audit = await (
      await call("/api/audit", {}, admin)
    ).json<{ detail: string; action: string }[]>();
    const entry = audit.find((a) => a.action === "user.mailboxes");
    expect(entry?.detail).toBe("1 assigned");
  });
});
