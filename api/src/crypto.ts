/**
 * Token encryption and hashing, built on Web Crypto so it runs on Workers.
 *
 * Broker tokens are encrypted at rest with AES-GCM. The key is a Worker
 * secret and never reaches D1, so a database leak alone does not expose
 * anyone's brokerage account.
 */

const IV_BYTES = 12;

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64Decode(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(rawKey: string): Promise<CryptoKey> {
  const keyBytes = base64Decode(rawKey);
  if (keyBytes.length !== 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded. Generate one with: openssl rand -base64 32",
    );
  }
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Encrypt a token. The random IV is prefixed to the ciphertext. */
export async function encryptToken(
  plaintext: string,
  rawKey: string,
): Promise<string> {
  const key = await importKey(rawKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );

  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return base64Encode(combined);
}

export async function decryptToken(
  ciphertext: string,
  rawKey: string,
): Promise<string> {
  const key = await importKey(rawKey);
  const combined = base64Decode(ciphertext);
  const iv = combined.slice(0, IV_BYTES);
  const body = combined.slice(IV_BYTES);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    body,
  );
  return new TextDecoder().decode(plaintext);
}

/** SHA-256, hex-encoded. Used for login tokens stored at rest. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** URL-safe random token. */
export function randomToken(bytes = 32): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return base64Encode(values)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomToken(12)}`;
}

/**
 * Constant-time string comparison, so token validation cannot be narrowed
 * by timing.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** HMAC-SHA256 signature, hex-encoded. Used to sign OAuth `state`. */
export async function hmacSign(
  message: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hmacVerify(
  message: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  return timingSafeEqual(await hmacSign(message, secret), signature);
}
