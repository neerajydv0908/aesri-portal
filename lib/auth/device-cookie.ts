/**
 * The "known device" cookie's contents (lib/auth/device.ts reads and writes
 * the cookie itself). Pure functions, so they can be tested on their own.
 *
 * The value holds a random id for the browser and, for up to five accounts
 * that signed in on it, a short tag and an HMAC of (browser id, account,
 * when its password was last set), keyed from APP_SECRET: "v1.<browser
 * id>.<tag>-<hmac>.<tag>-<hmac>…". It says nothing readable about the
 * accounts and works only for the same password.
 */
import crypto from "node:crypto";
import { deviceMac, safeEqualHex } from "./crypto";

export const MAX_DEVICE_ACCOUNTS = 5;

export type DeviceAccount = { id: string; passwordChangedAt: Date | null };
type Entry = { tag: string; mac: string };
export type ParsedDeviceCookie = { deviceId: string; entries: Entry[] };

const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/;
const ENTRY = /^([0-9a-f]{16})-([0-9a-f]{32})$/;

const tagOf = (accountId: string) => deviceMac(`tag|${accountId}`).slice(0, 16);
const macOf = (deviceId: string, a: DeviceAccount) => deviceMac(`v1|${deviceId}|${a.id}|${a.passwordChangedAt?.getTime() ?? 0}`).slice(0, 32);

/** Read the cookie; anything malformed counts as no cookie. */
export function parseDeviceCookie(value: string | undefined): ParsedDeviceCookie | null {
  if (!value || value.length > 600) return null;
  const [version, deviceId, ...rest] = value.split(".");
  if (version !== "v1" || !DEVICE_ID.test(deviceId ?? "")) return null;
  const entries: Entry[] = [];
  for (const part of rest.slice(0, MAX_DEVICE_ACCOUNTS)) {
    const m = ENTRY.exec(part);
    if (m) entries.push({ tag: m[1], mac: m[2] });
  }
  return { deviceId, entries };
}

/** The cookie's value with this account's entry first (a new browser id when there was none). */
export function deviceCookieValue(current: ParsedDeviceCookie | null, a: DeviceAccount): string {
  const deviceId = current?.deviceId ?? crypto.randomBytes(16).toString("base64url");
  const tag = tagOf(a.id);
  const others = (current?.entries ?? []).filter((e) => e.tag !== tag).slice(0, MAX_DEVICE_ACCOUNTS - 1);
  return ["v1", deviceId, `${tag}-${macOf(deviceId, a)}`, ...others.map((e) => `${e.tag}-${e.mac}`)].join(".");
}

/** Does this cookie say the browser signed in to this account, with its current password? Returns the browser's id. */
export function knownDeviceIn(parsed: ParsedDeviceCookie | null, a: DeviceAccount): string | null {
  if (!parsed) return null;
  const tag = tagOf(a.id);
  const entry = parsed.entries.find((e) => e.tag === tag);
  return entry && safeEqualHex(entry.mac, macOf(parsed.deviceId, a)) ? parsed.deviceId : null;
}
