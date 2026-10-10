/**
 * "This phone or computer has signed in to this account before": a cookie
 * that only this server can make, so a family can keep signing in on their
 * own phone while someone elsewhere is guessing their password (see the
 * daily cap in lib/auth/throttle.ts). Tries from a known device count on
 * that device's own counter (10 every 15 minutes) instead of the login ID's.
 *
 * What the cookie holds is in ./device-cookie.ts. It works only for the
 * same password (a new slip or a password change makes it stale until the
 * next right sign-in), and it never signs anyone in: it only decides which
 * counter a try uses.
 */
import "server-only";
import { cookies } from "next/headers";
import { appUrl } from "@/lib/env";
import { deviceCookieValue, knownDeviceIn, parseDeviceCookie, type DeviceAccount } from "./device-cookie";

/** Browsers keep a cookie at most 400 days. */
const MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

const secureCookies = () => appUrl().startsWith("https://");
export const deviceCookieName = () => (secureCookies() ? "__Host-aesri_device" : "aesri_device");

/** The id of this browser if it has signed in to this account before (with its current password), else null. */
export async function knownDevice(a: DeviceAccount): Promise<string | null> {
  return knownDeviceIn(parseDeviceCookie((await cookies()).get(deviceCookieName())?.value), a);
}

/** After a right sign-in (or a new password): remember this browser for the account. */
export async function rememberDevice(a: DeviceAccount): Promise<void> {
  const jar = await cookies();
  const value = deviceCookieValue(parseDeviceCookie(jar.get(deviceCookieName())?.value), a);
  jar.set(deviceCookieName(), value, { httpOnly: true, secure: secureCookies(), sameSite: "lax", path: "/", maxAge: MAX_AGE_SECONDS });
}
