import { HttpError } from "./http";

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "="
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function generateFamilyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64Url(bytes);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return hex(new Uint8Array(digest));
}

export async function familyKeyMatches(
  suppliedKey: string,
  storedHash: string
): Promise<boolean> {
  const suppliedHash = await sha256Hex(suppliedKey);
  return constantTimeEqual(suppliedHash, storedHash);
}

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: 100_000
    },
    key,
    256
  );
  return `pbkdf2$100000$${base64Url(salt)}$${base64Url(new Uint8Array(derived))}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [algorithm, iterationText, saltText, expectedText] = stored.split("$");
  const iterations = Number(iterationText);
  if (
    algorithm !== "pbkdf2" ||
    !Number.isInteger(iterations) ||
    !saltText ||
    !expectedText
  ) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: fromBase64Url(saltText),
      iterations
    },
    key,
    256
  );
  return constantTimeEqual(base64Url(new Uint8Array(derived)), expectedText);
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64Url(new Uint8Array(signature));
}

export async function createParentSession(
  secret: string,
  now: Date
): Promise<{ token: string; expiresAt: string }> {
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
  const payload = base64Url(
    encoder.encode(JSON.stringify({ exp: Math.floor(expiresAt.getTime() / 1000) }))
  );
  return {
    token: `${payload}.${await hmac(payload, secret)}`,
    expiresAt: expiresAt.toISOString()
  };
}

export async function requireValidParentSession(
  request: Request,
  secret: string,
  now: Date
): Promise<void> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new HttpError(
      403,
      "PARENT_SESSION_REQUIRED",
      "親PINを入力してください。"
    );
  }
  const [payload, signature] = authorization.slice(7).split(".");
  if (!payload || !signature) {
    throw new HttpError(403, "INVALID_PARENT_SESSION", "親セッションが無効です。");
  }
  const expected = await hmac(payload, secret);
  if (!constantTimeEqual(signature, expected)) {
    throw new HttpError(403, "INVALID_PARENT_SESSION", "親セッションが無効です。");
  }
  try {
    const decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as {
      exp?: unknown;
    };
    if (
      typeof decoded.exp !== "number" ||
      decoded.exp <= Math.floor(now.getTime() / 1000)
    ) {
      throw new Error("expired");
    }
  } catch {
    throw new HttpError(403, "INVALID_PARENT_SESSION", "親セッションが無効です。");
  }
}
