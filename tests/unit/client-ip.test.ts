/**
 * lib/auth/client-ip.ts: the visitor's address is taken TRUSTED_PROXY_HOPS
 * entries from the right of X-Forwarded-For, never from what the visitor wrote.
 *
 *   node --import tsx --test tests/unit/client-ip.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { clientIpFrom, ipBucket, normalizeIp, UNKNOWN_IP } from "../../lib/auth/client-ip";

const h = (xff?: string) => new Headers(xff === undefined ? {} : { "x-forwarded-for": xff });

test("one proxy (the default): the address the proxy appended, whatever the visitor sent", () => {
  assert.equal(clientIpFrom(h("203.0.113.9"), 1), "203.0.113.9");
  assert.equal(clientIpFrom(h("6.6.6.6, 203.0.113.9"), 1), "203.0.113.9");
  assert.equal(clientIpFrom(h("6.6.6.6,7.7.7.7 , 203.0.113.9"), 1), "203.0.113.9");
});

test("two proxies (e.g. Cloudflare, then nginx): the second from the right", () => {
  assert.equal(clientIpFrom(h("6.6.6.6, 203.0.113.9, 172.64.1.1"), 2), "203.0.113.9");
  assert.equal(clientIpFrom(h("203.0.113.9, 172.64.1.1"), 2), "203.0.113.9");
});

test("fewer entries than proxies: unknown (the request skipped a proxy), never the visitor's own claim", () => {
  assert.equal(clientIpFrom(h("6.6.6.6"), 2), UNKNOWN_IP);
  assert.equal(clientIpFrom(h(""), 1), UNKNOWN_IP);
  assert.equal(clientIpFrom(h(), 1), UNKNOWN_IP);
});

test("no proxy (0): the last entry, which Next.js fills in from the connection", () => {
  assert.equal(clientIpFrom(h("::ffff:127.0.0.1"), 0), "127.0.0.1");
  assert.equal(clientIpFrom(h("::1"), 0), "::1");
});

test("garbage in the trusted position is recorded as unknown", () => {
  assert.equal(clientIpFrom(h("1.2.3.4, <script>"), 1), UNKNOWN_IP);
  assert.equal(clientIpFrom(h("1.2.3.4, 999.1.1.1"), 1), UNKNOWN_IP);
  assert.equal(clientIpFrom(h(`1.2.3.4, ${"a".repeat(500)}`), 1), UNKNOWN_IP);
});

test("addresses are normalised the way proxies write them", () => {
  assert.equal(normalizeIp("1.2.3.4:5678"), "1.2.3.4");
  assert.equal(normalizeIp("[2001:DB8::1]:443"), "2001:db8::1");
  assert.equal(normalizeIp("::ffff:10.0.0.5"), "10.0.0.5");
  assert.equal(normalizeIp("fe80::1%eth0"), "fe80::1");
  assert.equal(normalizeIp("unknown"), null);
});

test("IPv6 addresses are counted per /64, IPv4 per address", () => {
  assert.equal(ipBucket("203.0.113.9"), "203.0.113.9");
  assert.equal(ipBucket("2401:4900:1c2a:5f1e:1234:5678:9abc:def0"), "2401:4900:1c2a:5f1e::/64");
  assert.equal(ipBucket("2401:4900:1c2a:5f1e::7"), "2401:4900:1c2a:5f1e::/64");
  assert.equal(ipBucket("2401:4900::1"), "2401:4900:0:0::/64");
  assert.equal(ipBucket("::1"), "0:0:0:0::/64");
  assert.equal(ipBucket("64:ff9b::1.2.3.4"), "64:ff9b:0:0::/64");
  assert.equal(ipBucket(UNKNOWN_IP), UNKNOWN_IP);
});
