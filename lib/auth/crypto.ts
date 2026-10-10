/**
 * Cryptography used by the portal. Everything here uses Node's built-in
 * `crypto` module and established algorithms:
 *
 *   - Passwords: scrypt (memory-hard; OWASP-recommended parameters)
 *   - One-time codes: HMAC-SHA-256 with a key derived from APP_SECRET
 *   - Session and trusted-browser tokens: 256-bit random, stored as SHA-256
 *   - Two-factor secrets: AES-256-GCM encryption at rest
 */
import crypto from "node:crypto";
import { appSecret } from "@/lib/env";

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

const keyCache = new Map<string, Buffer>();
function subKey(label: string): Buffer {
  let k = keyCache.get(label);
  if (!k) {
    k = Buffer.from(crypto.hkdfSync("sha256", appSecret(), "aesri-portal", `aesri:${label}`, 32));
    keyCache.set(label, k);
  }
  return k;
}

/* ------------------------------------------------------------------ */
/* Passwords                                                           */
/* ------------------------------------------------------------------ */

// OWASP Password Storage Cheat Sheet lists N=2^15, r=8, p=3 as an accepted scrypt setting.
const SCRYPT = { log2N: 15, r: 8, p: 3, keyLen: 32 };

function scrypt(password: string, salt: Buffer, log2N: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize("NFKC"), salt, keyLen, { N: 2 ** log2N, r, p, maxmem: 256 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.log2N, SCRYPT.r, SCRYPT.p, SCRYPT.keyLen);
  return ["scrypt", SCRYPT.log2N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    // Spend comparable time so response times don't reveal whether an account exists.
    await scrypt(password, Buffer.alloc(16), SCRYPT.log2N, SCRYPT.r, SCRYPT.p, SCRYPT.keyLen);
    return false;
  }
  const [alg, n, r, p, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(keyB64, "base64url");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64url"), Number(n), Number(r), Number(p), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * Password rules: length, as current guidance recommends, plus a block on
 * the passwords people guess first. Login IDs are easy to work out (the
 * school's prefix and an SR or employee number), so a password must not be:
 * the ID itself, a well-known password, a common word or the school's own
 * name dressed up with digits and symbols ("Aryavart@123", "Password@2026"),
 * only digits and symbols (a mobile number or a date of birth), or one
 * character repeated.
 */
export function passwordProblem(password: string, loginId: string): string | null {
  if (password.length < 8) return "too_short";
  if (password.length > 128) return "too_long";
  const lower = password.toLowerCase();
  if (lower.includes(loginId.toLowerCase())) return "contains_id";
  if (COMMON.has(lower)) return "too_common";
  // No letters and nearly all digits (any script): a mobile number or a date of birth, perhaps with a symbol or two.
  if (!/\p{L}/u.test(password) && password.length < 16 && password.replace(/[\p{Nd}\s\-/._]/gu, "").length <= 3) return "too_common";
  // A common word, alone or with a letter or two after it once look-alikes are read as letters ("Welc0m3@1").
  if (wordForms(lower).some((f) => COMMON_WORDS.has(f) || COMMON_STEMS.some((w) => f.startsWith(w) && f.length - w.length <= 2))) return "too_common";
  if (/^(.)\1+$/u.test(lower)) return "too_common";
  return null;
}

/** Look-alike characters people swap into words ("P@ssw0rd", "Adm1n"). */
const LEET: Record<string, string> = { "0": "o", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "!": "i" };

/**
 * The word a password is built on: its letters, and the same with look-alike
 * characters read as letters ("Sch00l@2026" → "school", "1ndia@123" → "india").
 */
function wordForms(lower: string): string[] {
  const lettersOnly = (s: string) => s.replace(/[^\p{L}]/gu, "");
  const forms = new Set([lettersOnly(lower)]);
  const trailing = lower.replace(/[^\p{L}]+$/u, ""); // "adm1n@123" → "adm1n"
  const digitsOff = lower.replace(/[\p{Nd}\s]+$/u, ""); // "krishn@123" → "krishn@"
  for (const base of [trailing, trailing.replace(/^[^\p{L}]+/u, ""), digitsOff]) {
    for (const one of ["i", "l"]) forms.add(lettersOnly(base.replace(/[01345@$7!]/g, (ch) => (ch === "1" ? one : LEET[ch]))));
  }
  return [...forms];
}

/** Words that, with digits and symbols around them, make up most guessed passwords (compared letters only). */
const COMMON_WORDS = new Set([
  "password", "passwd", "pass", "passw", "pwd", "welcome", "qwerty", "qwertyuiop", "asdf", "asdfgh", "asdfghjkl", "zxcvbnm",
  "abc", "abcd", "abcde", "abcdef", "abcdefg", "abcdefgh", "admin", "administrator", "login", "user", "guest", "test", "demo",
  "india", "bharat", "hindustan", "jaihind", "love", "iloveyou", "sairam", "krishna", "ganesh", "shiva", "hanuman", "jaishreeram",
  "school", "student", "teacher", "principal", "office", "portal", "parent", "family",
  "arya", "aryavart", "aryavartpublicschool", "aps", "aadhar", "aadharshila", "aadharshilapublicschool", "aesri",
  "palana", "udairamsar", "bikaner", "rajasthan", "cricket", "football", "sunshine", "monkey", "dragon", "princess",
]);

/** Longer common words, also refused with one or two letters added. */
const COMMON_STEMS = [...COMMON_WORDS].filter((w) => w.length >= 5);

const COMMON = new Set([
  "password", "password1", "password123", "12345678", "123456789", "1234567890", "11111111", "00000000", "qwerty123",
  "iloveyou", "abcd1234", "abc12345", "india123", "welcome1", "welcome123", "admin123", "school123", "aesri123",
  "aryavart", "aadharshila", "qwertyuiop", "asdfghjkl", "87654321", "12341234", "11223344", "1q2w3e4r", "passw0rd",
]);

/* ------------------------------------------------------------------ */
/* One-time codes (printed on slips)                                   */
/* ------------------------------------------------------------------ */

/** No look-alike characters: 0/O, 1/I/L are left out. 31 symbols. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function newOneTimeCode(): string {
  let c = "";
  for (let i = 0; i < 8; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/** Keyed fingerprint of a code, bound to its account. Only this is stored. */
export function codeFingerprint(code: string, accountId: string): string {
  return crypto.createHmac("sha256", subKey("codes")).update(`${accountId}:${normalizeCode(code)}`).digest("hex");
}

export function fingerprintsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/* ------------------------------------------------------------------ */
/* Session tokens                                                      */
/* ------------------------------------------------------------------ */

export function newSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function sessionIdFromToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Encryption at rest (two-factor secrets)                             */
/* ------------------------------------------------------------------ */

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", subKey("totp"), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), enc.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

export function decryptSecret(stored: string): string {
  const [v, ivB64, encB64, tagB64] = stored.split(".");
  if (v !== "v1") throw new Error("Unknown secret format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", subKey("totp"), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encB64, "base64url")), decipher.final()]).toString("utf8");
}

/* ------------------------------------------------------------------ */
/* Webhook / payment signatures                                        */
/* ------------------------------------------------------------------ */

export function hmacHex(key: string, message: string | Buffer): string {
  return crypto.createHmac("sha256", key).update(message).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Key used to sign the built-in test checkout's webhooks. */
export function mockWebhookKey(): string {
  return subKey("mock-payments").toString("hex");
}

/** Keyed fingerprint for the "known device" cookie (lib/auth/device.ts): only this server can make or check one. */
export function deviceMac(message: string): string {
  return crypto.createHmac("sha256", subKey("known-devices")).update(message).digest("hex");
}

/**
 * Keyed fingerprint for trusted browsers (lib/auth/trusted.ts): which entry
 * of the cookie is whose, and which authenticator key a browser was trusted with.
 */
export function trustMac(message: string): string {
  return crypto.createHmac("sha256", subKey("trusted-browsers")).update(message).digest("hex");
}
