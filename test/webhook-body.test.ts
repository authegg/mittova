import { describe, expect, it } from "vitest";
import { webhookBody } from "../src/services/events";

const event = {
  type: "email.received",
  createdAt: "2026-10-28T00:00:00.000Z",
  data: { from: "a@example.com", to: "support@clodous.com", subject: "Hi @everyone" },
};

describe("webhookBody", () => {
  it("sends Discord a message it accepts, without pinging the channel", () => {
    const body = JSON.parse(webhookBody("https://discord.com/api/webhooks/1/abc", event));
    expect(body.content).toContain("support@clodous.com");
    expect(body.content).toContain("a@example.com");
    expect(body.content).toContain("Hi @everyone");
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it("sends every other endpoint the envelope unchanged", () => {
    expect(webhookBody("https://example.com/discord.com/api/webhooks/1", event)).toBe(JSON.stringify(event));
  });
});
