import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, passwordProblem } from "./password";

describe("password hashing", () => {
  it("verifies the correct password and rejects a wrong one", async () => {
    const record = await hashPassword("CorrectHorse42x");
    await expect(verifyPassword("CorrectHorse42x", record)).resolves.toBe(true);
    await expect(verifyPassword("CorrectHorse42y", record)).resolves.toBe(false);
    await expect(verifyPassword("", record)).resolves.toBe(false);
  });

  it("salts, so identical passwords produce different hashes", async () => {
    const a = await hashPassword("SamePassword12x");
    const b = await hashPassword("SamePassword12x");
    expect(a.passwordSalt).not.toBe(b.passwordSalt);
    expect(a.passwordHash).not.toBe(b.passwordHash);
    // Each still verifies against its own salt.
    await expect(verifyPassword("SamePassword12x", a)).resolves.toBe(true);
    await expect(verifyPassword("SamePassword12x", b)).resolves.toBe(true);
  });

  it("chains rounds because workerd caps one deriveBits call at 100k", async () => {
    const record = await hashPassword("ChainedRounds9x");
    expect(record.passwordIterations).toBeGreaterThan(100_000);
    await expect(verifyPassword("ChainedRounds9x", record)).resolves.toBe(true);
  });

  it("honours the iteration count stored on the record", async () => {
    const record = await hashPassword("StoredFactor42x");
    // A record hashed at a different work factor must not verify.
    const tampered = { ...record, passwordIterations: 100_000 };
    await expect(verifyPassword("StoredFactor42x", tampered)).resolves.toBe(false);
  });

  it("handles unicode and long input", async () => {
    const pw = "🔐 pässwörd with spaces " + "x".repeat(200);
    const record = await hashPassword(pw);
    await expect(verifyPassword(pw, record)).resolves.toBe(true);
  });
});

describe("passwordProblem", () => {
  it("accepts a password meeting every rule", () => {
    expect(passwordProblem("LongEnough1Pass")).toBeNull();
  });

  it.each([
    ["Short1x", "too short"],
    ["alllowercase1", "no upper case"],
    ["ALLUPPERCASE1", "no lower case"],
    ["NoDigitsHereAtAll", "no digit"],
  ])("rejects %j (%s)", (pw) => {
    expect(passwordProblem(pw)).toBeTypeOf("string");
  });
});
