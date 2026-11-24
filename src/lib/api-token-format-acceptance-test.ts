// Bot API tokens: the raw token format, hash and display prefix (src/lib/api-token-format.ts). Pure, no DB.
// Run: npx tsx src/lib/api-token-format-acceptance-test.ts
import { createHash } from "node:crypto";
import {
  API_TOKEN_PREFIX,
  apiTokenPrefix,
  base62,
  generateRawToken,
  hashApiToken,
  isWellFormedApiToken,
  maskedApiToken,
  parseBearerToken,
} from "./api-token-format";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

// ---- generation ----
{
  const tokens = Array.from({ length: 200 }, () => generateRawToken());
  check("every token is bv_live_ + 43 base62 characters", tokens.every((t) => /^bv_live_[0-9A-Za-z]{43}$/.test(t)), tokens[0]);
  check("200 generated tokens are all distinct", new Set(tokens).size === 200);
  check("generated tokens are well formed", tokens.every(isWellFormedApiToken));

  const zeros = generateRawToken(() => new Uint8Array(32));
  check("all-zero bytes encode as 43 zeros (fixed length)", zeros === API_TOKEN_PREFIX + "0".repeat(43), zeros);
  const max = generateRawToken(() => new Uint8Array(32).fill(255));
  check("all-0xFF bytes still fit in 43 characters", max.length === API_TOKEN_PREFIX.length + 43, max);
  check("base62 of 61 is 'z', of 62 is '10'", base62(Uint8Array.of(61), 1) === "z" && base62(Uint8Array.of(62), 2) === "10");
  // Uses the random source it is given, 32 bytes.
  let asked = 0;
  generateRawToken((n) => ((asked = n), new Uint8Array(n)));
  check("asks for exactly 32 random bytes", asked === 32);
}

// ---- hash + prefix ----
{
  const raw = API_TOKEN_PREFIX + "7Kq2" + "a".repeat(39);
  const hash = hashApiToken(raw);
  check("hash is SHA-256 hex of the whole raw token", hash === createHash("sha256").update(raw).digest("hex"), hash);
  check("hash is 64 lowercase hex characters", /^[0-9a-f]{64}$/.test(hash));
  check("hash differs from the raw token and does not contain it", hash !== raw && !hash.includes("7Kq2"));
  check("prefix is bv_live_ + the first 4 random characters", apiTokenPrefix(raw) === "bv_live_7Kq2", apiTokenPrefix(raw));
  check("masked display is bv_live_7Kq2••••", maskedApiToken(apiTokenPrefix(raw)) === "bv_live_7Kq2••••");
}

// ---- parsing the Authorization header ----
{
  const raw = generateRawToken();
  check("Bearer <token> parses", parseBearerToken(`Bearer ${raw}`) === raw);
  check("scheme is case-insensitive", parseBearerToken(`bearer ${raw}`) === raw);
  check("missing header -> null", parseBearerToken(null) === null && parseBearerToken("") === null);
  check("wrong scheme -> null", parseBearerToken(`Basic ${raw}`) === null);
  check("no scheme -> null", parseBearerToken(raw) === null);
  check("wrong prefix -> null", parseBearerToken(`Bearer bv_test_${raw.slice(8)}`) === null);
  check("too short -> null", parseBearerToken(`Bearer ${raw.slice(0, -1)}`) === null);
  check("too long -> null", parseBearerToken(`Bearer ${raw}x`) === null);
  check("non-base62 character -> null", parseBearerToken(`Bearer ${raw.slice(0, -1)}-`) === null);
  check("two tokens -> null", parseBearerToken(`Bearer ${raw} ${raw}`) === null);
}

process.exit(failures > 0 ? 1 : 0);
