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

    // The built-in design: the button survives the layout sanitiser.
    const html = (send.mock.calls[0] as unknown[] as [{ html: string; subject: string }])[0];
    expect(html.subject).toBe("Your Alpha mail account");
    expect(html.html).toContain(`href="https://mail.example/#/accept/${made.inviteToken}"`);
  });

  it("uses the org's own user-invite template, its sender, and escapes what it fills in", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "insert into templates (id,slug,name,subject,body_text,body_html,from_address,reply_to,org_id,updated_at,created_at) values (?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        "t1",
        "user-invite",
        "Invite",
        "Welcome {{name}}",
        "Go: {{link}}",
        '<p>Hi {{name}}, <a href="{{link}}">start</a></p>',
        "desk@alpha.test",
        "",
        "org_alpha",
        now,
        now,
      )
      .run();
    await env.DB.prepare("update organizations set name = ? where id = ?")
      .bind("<b>Alpha</b>", "org_alpha")
      .run();

    const send = vi.fn(async () => ({ messageId: "m" }));
    const res = await call(
      "/api/users",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: await admin(),
          "x-mittova-org": "org_alpha",
        },
        body: JSON.stringify({ email: "n@p.test", name: "<i>Ann</i>", mailboxIds: ["mb_sales"] }),
      },
      { ...env, EMAIL: { send } } as unknown as Env,
    );
    const made = await res.json<{ inviteToken: string; inviteMail: unknown }>();

    // The template's sender beats the mailbox the account is given.
    expect(made.inviteMail).toEqual({ from: "desk@alpha.test" });
    const sent = (
      send.mock.calls[0] as unknown[] as [{ subject: string; text: string; html: string }]
    )[0];
    expect(sent.subject).toBe("Welcome <i>Ann</i>");
    expect(sent.text).toBe(`Go: https://mail.example/#/accept/${made.inviteToken}`);
    expect(sent.html).toContain("&#60;i&#62;Ann");
    expect(sent.html).not.toContain("<i>");
  });

  it("serves the built-in invite as a starter, not as a template id", async () => {
    const res = await call("/api/templates/starters", {
      headers: { cookie: await admin(), "x-mittova-org": "org_alpha" },
    });
    expect(res.status).toBe(200);
    const [starter] = await res.json<{ slug: string; bodyHtml: string }[]>();
    expect(starter.slug).toBe("user-invite");
    expect(starter.bodyHtml).toContain("{{link}}");
  });

  it("still creates the account and hands back the link when sending fails", async () => {
    const made = await invite(env); // no send_email binding under test
    expect(made.inviteToken).toMatch(/^[0-9a-f]{64}$/);
    expect("error" in made.inviteMail).toBe(true);
  });

  // The row's Invite button: this route once ran ahead of its auth middleware
  // and answered 500 to everyone.
  it("re-sends an invite from the row's Invite button, and refuses a stranger", async () => {
    const send = vi.fn(async () => ({ messageId: "m" }));
    const withMail = { ...env, EMAIL: { send } } as unknown as Env;
    const made = await invite(withMail, ["mb_desk"]);
    const id = (made as unknown as { id: string }).id;

    const again = await call(
      `/api/users/${id}/invite`,
      { method: "POST", headers: { cookie: await admin() } },
      withMail,
    );
    expect(again.status).toBe(200);
    const body = await again.json<{ inviteToken: string; inviteMail: unknown }>();
    expect(body.inviteToken).not.toBe(made.inviteToken);
    expect(body.inviteMail).toEqual({ from: "desk@alpha.test" });
    expect(send).toHaveBeenCalledTimes(2);

    const stranger = await call(`/api/users/${id}/invite`, { method: "POST" }, withMail);
    expect(stranger.status).toBe(401);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
