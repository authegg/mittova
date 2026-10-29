import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

/**
 * Creating a user by invite emails the link, and the link stays out of every
 * mailbox's Sent folder, where anyone else with that mailbox could use it.
 */
async function call(path: string, init: RequestInit, useEnv: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://mail.example${path}`, init), useEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function admin(): Promise<string> {
  const res = await call("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-admin-password" }),
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

/** Created from "All organizations", naming the org the way the form does. */
async function invite(useEnv: Env, mailboxIds: string[] = []) {
  const res = await call(
    "/api/users",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: await admin(),
        "x-mittova-org": "org_alpha",
      },
      body: JSON.stringify({ email: "new@person.test", name: "New", role: "member", mailboxIds }),
    },
    useEnv,
  );
  expect(res.status).toBe(201);
  return res.json<{
    orgId: string;
    inviteToken: string;
    inviteMail: { from: string } | { error: string };
  }>();
}

describe("invite mail", () => {
  beforeEach(async () => {
    const now = Date.now();
    const rows: [string, unknown[]][] = [
      [
        "insert into organizations (id,name,slug,created_at) values (?,?,?,?)",
        ["org_alpha", "Alpha", "alpha", now],
      ],
      [
        "insert into mailboxes (id,address,name,daily_send_limit,reply_to,org_id,created_at) values (?,?,?,?,?,?,?)",
        ["mb_desk", "desk@alpha.test", "Desk", 200, "", "org_alpha", now],
      ],
      [
        "insert into mailboxes (id,address,name,daily_send_limit,reply_to,org_id,created_at) values (?,?,?,?,?,?,?)",
        ["mb_sales", "sales@alpha.test", "Sales", 200, "", "org_alpha", now],
      ],
    ];
    for (const [sql, args] of rows)
      await env.DB.prepare(sql)
        .bind(...args)
        .run();
  });

  it("emails the link from a mailbox the account is given, and keeps no copy", async () => {
    const send = vi.fn(async () => ({ messageId: "m" }));
    const made = await invite({ ...env, EMAIL: { send } } as unknown as Env, ["mb_sales"]);

    expect(made.orgId).toBe("org_alpha");
    expect(made.inviteMail).toEqual({ from: "sales@alpha.test" });
    expect(send).toHaveBeenCalledOnce();
    const sent = (send.mock.calls[0] as unknown[])[0] as { to: string; text: string };
    expect(sent.to).toBe("new@person.test");
    expect(sent.text).toContain(`https://mail.example/#/accept/${made.inviteToken}`);

    const stored = await env.DB.prepare("select count(*) as n from messages").first<{
      n: number;
    }>();
    expect(stored?.n).toBe(0);
  });

  it("still creates the account and hands back the link when sending fails", async () => {
    const made = await invite(env); // no send_email binding under test
    expect(made.inviteToken).toMatch(/^[0-9a-f]{64}$/);
    expect("error" in made.inviteMail).toBe(true);
  });
});
