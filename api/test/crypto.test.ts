import { describe, expect, it } from "vitest";
import {
  decryptToken,
  encryptToken,
  hmacSign,
  hmacVerify,
  randomToken,
  sha256Hex,
  timingSafeEqual,
} from "../src/crypto.js";

// 32 bytes, base64, matching what `openssl rand -base64 32` produces.
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7 % 256)));
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

describe("token encryption", () => {
  it("round-trips a token", async () => {
    const secret = "super-secret-broker-token";
    const encrypted = await encryptToken(secret, KEY);
    expect(await decryptToken(encrypted, KEY)).toBe(secret);
  });

  it("never emits the plaintext in the ciphertext", async () => {
    const secret = "super-secret-broker-token";
    const encrypted = await encryptToken(secret, KEY);
    expect(encrypted).not.toContain(secret);
  });

  it("produces different ciphertext each time, from the random IV", async () => {
    const a = await encryptToken("same", KEY);
    const b = await encryptToken("same", KEY);
    expect(a).not.toBe(b);
    expect(await decryptToken(a, KEY)).toBe("same");
    expect(await decryptToken(b, KEY)).toBe("same");
  });

  it("fails to decrypt under the wrong key", async () => {
    const encrypted = await encryptToken("secret", KEY);
    await expect(decryptToken(encrypted, OTHER_KEY)).rejects.toThrow();
  });

  it("fails to decrypt tampered ciphertext", async () => {
    const encrypted = await encryptToken("secret", KEY);
    // Flip a character in the body; AES-GCM authenticates, so this must fail.
    const tampered =
      encrypted.slice(0, -4) + (encrypted.slice(-4, -3) === "A" ? "B" : "A") + encrypted.slice(-3);
    await expect(decryptToken(tampered, KEY)).rejects.toThrow();
  });

  it("rejects a key of the wrong length", async () => {
    await expect(encryptToken("secret", btoa("tooshort"))).rejects.toThrow(
      /32 bytes/,
    );
  });

  it("handles unicode and long tokens", async () => {
    const secret = "🔐 " + "x".repeat(5000);
    expect(await decryptToken(await encryptToken(secret, KEY), KEY)).toBe(secret);
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of the empty string", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("is deterministic and differs across inputs", async () => {
    expect(await sha256Hex("a")).toBe(await sha256Hex("a"));
    expect(await sha256Hex("a")).not.toBe(await sha256Hex("b"));
  });
});

describe("randomToken", () => {
  it("produces URL-safe output", () => {
    for (let i = 0; i < 50; i++) {
      expect(randomToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, () => randomToken()));
    expect(seen.size).toBe(500);
  });
});

describe("timingSafeEqual", () => {
  it("compares equal strings as equal", () => {
    expect(timingSafeEqual("abc123", "abc123")).toBe(true);
  });

  it("rejects differing strings", () => {
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("HMAC state signing", () => {
  it("verifies a signature it produced", async () => {
    const message = "usr_1:schwab:nonce";
    const signature = await hmacSign(message, "secret");
    expect(await hmacVerify(message, signature, "secret")).toBe(true);
  });

  it("rejects a tampered message", async () => {
    const signature = await hmacSign("usr_1:schwab:nonce", "secret");
    // The attack this defends against: swapping in another user's ID.
    expect(await hmacVerify("usr_2:schwab:nonce", signature, "secret")).toBe(
      false,
    );
  });

  it("rejects a signature made with a different secret", async () => {
    const signature = await hmacSign("message", "secret-a");
    expect(await hmacVerify("message", signature, "secret-b")).toBe(false);
  });

  it("rejects a malformed signature", async () => {
    expect(await hmacVerify("message", "not-a-signature", "secret")).toBe(false);
  });
});
