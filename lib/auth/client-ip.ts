/**
 * The visitor's IP address, as far as the portal can trust it — the one
 * helper every page, Server Action and webhook uses (sign-in limits, the
 * activity log, sessions). See TRUSTED_PROXY_HOPS in lib/env.ts for how it
 * is read from X-Forwarded-For and why the leftmost entry is never trusted.
 *
 * No "server-only" here, so scripts and unit tests can use it.
 */
import net from "node:net";
import { isProduction, trustedProxyHops } from "@/lib/env";

/** Recorded when no trustworthy address is available. */
export const UNKNOWN_IP = "unknown";

type HeaderSource = { get(name: string): string | null };

let warnedNoProxy = false;

/** The visitor's address from the request headers (IPv4 or IPv6, or "unknown"). */
export function clientIpFrom(headers: HeaderSource, hops: number = trustedProxyHops()): string {
  if (hops === 0 && isProduction() && !warnedNoProxy) {
    warnedNoProxy = true;
    console.warn("[portal] TRUSTED_PROXY_HOPS=0 on a production server: visitors can choose the address the portal records. Run it behind a reverse proxy.");
  }
  const entries = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fromRight = Math.max(1, hops);
  if (entries.length < fromRight) return UNKNOWN_IP;
  return normalizeIp(entries[entries.length - fromRight]) ?? UNKNOWN_IP;
}

/**
 * A plain IP address, or null. Accepts what proxies write: "1.2.3.4",
 * "1.2.3.4:5678", "2001:db8::1", "[2001:db8::1]:443", "::ffff:1.2.3.4".
 */
export function normalizeIp(value: string): string | null {
  let s = value.trim();
  if (!s || s.length > 100) return null;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracketed) s = bracketed[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(":"));
  s = s.replace(/%.*$/, ""); // IPv6 zone ("fe80::1%eth0")
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) s = mapped[1];
  const kind = net.isIP(s);
  if (kind === 4) return s;
  if (kind === 6) return s.toLowerCase();
  return null;
}

/** The eight 16-bit groups of a valid IPv6 address, as hex strings without leading zeros. */
function ipv6Groups(ip: string): string[] | null {
  let head = ip;
  let tail: string[] = [];
  const v4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (v4) {
    const [a, b, c, d] = v4[2].split(".").map(Number);
    tail = [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
    head = v4[1].endsWith("::") ? v4[1] : v4[1].slice(0, -1);
  }
  const parts = head.split("::");
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const missing = 8 - tail.length - left.length - right.length;
  if (parts.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...left, ...Array<string>(parts.length === 2 ? missing : 0).fill("0"), ...right, ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => Number.parseInt(g, 16).toString(16));
}

/**
 * What the per-address limits count by: an IPv4 address itself, or an
 * IPv6 address's /64 network (one household or phone usually has a whole
 * /64, so counting single IPv6 addresses would be easy to dodge).
 */
export function ipBucket(ip: string): string {
  if (net.isIP(ip) !== 6) return ip;
  const g = ipv6Groups(ip);
  return g ? `${g.slice(0, 4).join(":")}::/64` : ip;
}
