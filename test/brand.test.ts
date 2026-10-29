import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

/**
 * An org's logo: uploaded by a platform administrator, served to anyone so
 * mail can show it, and used by the invite email.
 */
async function call(path: string, init: RequestInit = {}, useEnv: Env = env): Promise<Response> {
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

/** A PNG header claiming 360 by 120: all the server reads. */
function png(width = 360, height = 120): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

async function upload(body: Uint8Array, cookie?: string): Promise<Response> {
  return call("/api/orgs/org_alpha/logo", {
    method: "PUT",
    headers: { "content-type": "image/png", ...(cookie ? { cookie } : {}) },
    body,
  });
}

describe("org logo", () => {
  beforeEach(async () => {
    const now = Date.now();
    await env.DB.prepare("insert into organizations (id,name,slug,created_at) values (?,?,?,?)")
      .bind("org_alpha", "Alpha", "alpha", now)
      .run();
    await env.DB.prepare(
      "insert into mailboxes (id,address,name,daily_send_limit,reply_to,org_id,created_at) values (?,?,?,?,?,?,?)",
    )
      .bind("mb_desk", "desk@alpha.test", "Desk", 200, "", "org_alpha", now)
      .run();
  });

  it("stores a PNG and serves it to anyone, unchanged", async () => {
    const bytes = png();
    const res = await upload(bytes, await admin());
    expect(res.status).toBe(200);
    const { logoUrl } = await res.json<{ logoUrl: string }>();
    expect(logoUrl).toMatch(/^\/api\/brand\/org_alpha\/logo\/[0-9a-f]{16}\.png$/);

    const served = await call(logoUrl); // no cookie: mail is read signed out
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);

    const orgs = await call("/api/orgs", { headers: { cookie: await admin() } });
    const listed = (await orgs.json<{ id: string; logoUrl: string | null }[]>()).find(
      (o) => o.id === "org_alpha",
    );
    expect(listed?.logoUrl).toBe(logoUrl);
  });

  it("refuses anything that is not a PNG, so the route can never serve HTML", async () => {
    const res = await upload(
      new TextEncoder().encode("<html><script>1</script></html>"),
      await admin(),
    );
    expect(res.status).toBe(400);
    const row = await env.DB.prepare(
      "select logo_key from organizations where id = 'org_alpha'",
    ).first();
    expect(row?.logo_key).toBeNull();
  });

  it("refuses an upload from someone signed out", async () => {
    expect((await upload(png())).status).toBe(401);
  });

  it("serves only hash-shaped names under the org's own prefix", async () => {
    await env.STORAGE.put("_backups/x.ndjson", "secret");
    for (const path of [
      "/api/brand/org_alpha/logo/..%2F..%2F_backups%2Fx.ndjson",
      "/api/brand/..%2F_backups/logo/x.ndjson",
      "/api/brand/org_alpha/logo/notahash.png",
    ]) {
      expect((await call(path)).status, path).toBe(404);
    }
  });

  it("puts the logo in the built-in invite, at half its stored size", async () => {
    const { logoUrl } = await (await upload(png(), await admin())).json<{ logoUrl: string }>();
    const send = vi.fn(async () => ({ messageId: "m" }));
    await call(
      "/api/users",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: await admin(),
          "x-mittova-org": "org_alpha",
        },
        body: JSON.stringify({ email: "n@p.test", name: "N" }),
      },
      { ...env, EMAIL: { send } } as unknown as Env,
    );
    const sent = (send.mock.calls[0] as unknown[] as [{ html: string }])[0];
    expect(sent.html).toContain(`src="https://mail.example${logoUrl}"`);
    expect(sent.html).toContain('width="180"');
    expect(sent.html).toContain('height="60"');
  });
});
