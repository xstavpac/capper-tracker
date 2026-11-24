// Bot API tokens: the raw token format, its hash and its display prefix. Pure (node:crypto only), no DB.
//
//   raw token  "bv_live_" + 32 cryptographically random bytes, base62 (0-9A-Za-z), left-padded to 43 characters
//   tokenHash  SHA-256 hex of the whole raw token - the only form stored
//   prefix     "bv_live_" + the first 4 characters of the random part, shown as "bv_live_7Kq2••••"
//
// The raw token exists only in the create action's return value. Never log it.
import { createHash, randomBytes } from "node:crypto";

export const API_TOKEN_PREFIX = "bv_live_";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// 62^43 > 2^256 > 62^42: every 32-byte value fits in 43 base62 digits.
export const API_TOKEN_RANDOM_LENGTH = 43;
const RAW_TOKEN_RE = new RegExp(`^${API_TOKEN_PREFIX}[0-9A-Za-z]{${API_TOKEN_RANDOM_LENGTH}}$`);

export function base62(bytes: Uint8Array, length: number): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(length, "0");
}

export function generateRawToken(random: (size: number) => Uint8Array = randomBytes): string {
  return API_TOKEN_PREFIX + base62(random(32), API_TOKEN_RANDOM_LENGTH);
}

export function hashApiToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function apiTokenPrefix(rawToken: string): string {
  return rawToken.slice(0, API_TOKEN_PREFIX.length + 4);
}

/** How a stored prefix is shown: "bv_live_7Kq2••••". */
export function maskedApiToken(prefix: string): string {
  return prefix + "••••";
}

export function isWellFormedApiToken(value: string): boolean {
  return RAW_TOKEN_RE.test(value);
}

/**
 * The token from an "Authorization: Bearer bv_live_…" header, or null when the header is missing or malformed
 * (wrong scheme, wrong prefix, wrong length or alphabet). The scheme is case-insensitive (RFC 7235).
 */
export function parseBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header);
  if (!m) return null;
  return isWellFormedApiToken(m[1]) ? m[1] : null;
}
