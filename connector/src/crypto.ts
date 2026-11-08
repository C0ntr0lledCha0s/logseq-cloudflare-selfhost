import { base64url } from "./auth/github";

/** AES-256-GCM key from exactly 64 hex characters. Throws on anything else (fail closed). */
export async function aesKeyFromHex(hex: string, name: string): Promise<CryptoKey> {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${name} must be 64 hex characters (32 bytes)`);
  const raw = new Uint8Array(32);
  for (let i = 0; i < 32; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function fromBase64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export { base64url };

/** Constant-time string compare (UTF-8 bytes); false at once when the lengths differ. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}
