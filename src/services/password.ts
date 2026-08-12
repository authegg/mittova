/**
 * PBKDF2-SHA256 password hashing on WebCrypto.
 *
 * Chosen over bcrypt/argon2 because it is native to the Workers runtime — no
 * WASM bundle, no cold-start cost. Iterations are stored per user so the work
 * factor can be raised later without invalidating existing hashes.
 */

/**
 * workerd rejects a single deriveBits call above 100k iterations, so the work
 * factor is reached by chaining rounds: each round's output becomes the next
 * round's key material, and the total work is the sum. Raising TOTAL later is
 * safe — existing hashes carry their own iteration count.
 */
const MAX_PER_CALL = 100_000;
const ITERATIONS = 200_000;
const KEY_BITS = 256;

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  let material: BufferSource = new TextEncoder().encode(password);
  let remaining = Math.max(1, iterations);
  let bits: ArrayBuffer | null = null;

  while (remaining > 0) {
    const round = Math.min(remaining, MAX_PER_CALL);
    const key = await crypto.subtle.importKey("raw", material, "PBKDF2", false, ["deriveBits"]);
    bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: salt as BufferSource, iterations: round, hash: "SHA-256" },
      key,
      KEY_BITS,
    );
    material = new Uint8Array(bits);
    remaining -= round;
  }

  return toHex(bits!);
}

export interface PasswordRecord {
  passwordHash: string;
  passwordSalt: string;
  passwordIterations: number;
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return {
    passwordHash: await derive(password, salt, ITERATIONS),
    passwordSalt: toHex(salt.buffer as ArrayBuffer),
    passwordIterations: ITERATIONS,
  };
}

/** Constant-time comparison so a wrong password can't be narrowed by timing. */
function equalHex(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  const candidate = await derive(password, fromHex(record.passwordSalt), record.passwordIterations);
  return equalHex(candidate, record.passwordHash);
}

/** Minimum bar for an owner-assigned password. */
export function passwordProblem(password: string): string | null {
  if (password.length < 12) return "Password must be at least 12 characters.";
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return "Password must include lower case, upper case and a digit.";
  }
  return null;
}
