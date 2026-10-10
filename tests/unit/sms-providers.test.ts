/**
 * lib/sms/providers.ts: what is sent to MSG91 and Fast2SMS, and how their
 * answers are read — with fetch mocked (the real services are never called).
 *
 *   node --import tsx --test tests/unit/sms-providers.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { senderIdFor, senderIdText, smsConfigProblem, smsPortalAddress } from "../../lib/sms/config";
import { FAST2SMS_URL, MSG91_URL, fast2smsProvider, fast2smsRequests, logProvider, msg91Body, msg91Provider, safeError, type OutgoingSms } from "../../lib/sms/providers";

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };
const realFetch = globalThis.fetch;
let calls: Call[] = [];

function mockFetch(answer: (call: Call) => { status?: number; json?: unknown; text?: string } | Error) {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const call: Call = { url: String(url), init: init ?? {}, body: init?.body ? JSON.parse(String(init.body)) : {} };
    calls.push(call);
    const a = answer(call);
    if (a instanceof Error) throw a;
    const text = a.text ?? JSON.stringify(a.json ?? {});
    return new Response(text, { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const saved = { ...process.env };
beforeEach(() => {
  calls = [];
  process.env.MSG91_AUTH_KEY = "msg91-secret-key";
  process.env.FAST2SMS_API_KEY = "f2s-secret-key";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...saved };
});

const msg = (id: string, to: string, vars: string[]): OutgoingSms => ({ id, to, vars, body: vars.join(" "), lang: "hi" });

test("MSG91: one call with the template, short links off, and each recipient's own variables as var1, var2…", async () => {
  mockFetch(() => ({ json: { type: "success", message: "3763646c3058373530393138" } }));
  const out = await msg91Provider.send("64f1c0ffee", [msg("a", "9876543210", ["School", "Rahul", "IV-A"]), msg("b", "9123456780", ["School", "Priya", "IV-A"])]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, MSG91_URL);
  assert.equal(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authkey, "msg91-secret-key");
  assert.equal(headers["content-type"], "application/json");
  assert.deepEqual(calls[0].body, {
    template_id: "64f1c0ffee",
    short_url: "0",
    recipients: [
      { mobiles: "919876543210", var1: "School", var2: "Rahul", var3: "IV-A" },
      { mobiles: "919123456780", var1: "School", var2: "Priya", var3: "IV-A" },
    ],
  });
  assert.deepEqual(out, [
    { id: "a", ok: true, ref: "3763646c3058373530393138" },
    { id: "b", ok: true, ref: "3763646c3058373530393138" },
  ]);
});

test("MSG91: an error answer fails the batch with MSG91's reason; many recipients go 100 per call", async () => {
  mockFetch(() => ({ status: 400, json: { type: "error", message: "Template ID Missing or Invalid Template" } }));
  const out = await msg91Provider.send("bad", [msg("a", "9876543210", ["x"])]);
  assert.deepEqual(out, [{ id: "a", ok: false, error: "MSG91: Template ID Missing or Invalid Template" }]);

  calls = [];
  mockFetch(() => ({ json: { type: "success", message: "req" } }));
  const many = Array.from({ length: 230 }, (_, i) => msg(`m${i}`, `98765${String(i).padStart(5, "0")}`, ["v"]));
  const res = await msg91Provider.send("tpl", many);
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => (c.body.recipients as unknown[]).length),
    [100, 100, 30],
  );
  assert.ok(res.every((r) => r.ok));
  assert.deepEqual(msg91Body("t", [msg("z", "9000000001", [])]), { template_id: "t", short_url: "0", recipients: [{ mobiles: "919000000001" }] });
});

test("Fast2SMS: DLT route, the school's sender ID and the message ID, variables joined with |, numbers comma-separated", async () => {
  mockFetch(() => ({ json: { return: true, request_id: "lwdtp7cjyqxvfe9", message: ["Message sent successfully"] } }));
  const same = ["School", "New notice title"];
  const out = await fast2smsProvider.send("171234", [msg("a", "9876543210", same), msg("b", "9123456780", same), msg("c", "9000000001", ["School", "Other"])], "AESRIS");
  assert.equal(calls.length, 2, "one call per set of identical variables");
  assert.equal(calls[0].url, FAST2SMS_URL);
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "f2s-secret-key");
  assert.deepEqual(calls[0].body, { route: "dlt", sender_id: "AESRIS", message: "171234", variables_values: "School|New notice title", numbers: "9876543210,9123456780", flash: "0" });
  assert.deepEqual(calls[1].body.numbers, "9000000001");
  assert.ok(out.every((o) => o.ok && o.ref === "lwdtp7cjyqxvfe9"));
  assert.equal(fast2smsRequests("1", "AESRIS", Array.from({ length: 150 }, (_, i) => msg(`m${i}`, `98765${String(i).padStart(5, "0")}`, ["same"]))).length, 2);
});

test("Fast2SMS: an error answer fails the messages with its code and reason", async () => {
  mockFetch(() => ({ status: 200, json: { return: false, status_code: 416, message: "You don't have sufficient wallet balance" } }));
  const out = await fast2smsProvider.send("171234", [msg("a", "9876543210", ["x"])], "AESRIS");
  assert.deepEqual(out, [{ id: "a", ok: false, error: "Fast2SMS (416): You don't have sufficient wallet balance" }]);
});

test("network trouble, time-outs and non-JSON answers fail the try (to be tried again), without leaking keys or numbers", async () => {
  mockFetch(() => new TypeError("fetch failed"));
  let out = await msg91Provider.send("t", [msg("a", "9876543210", ["x"])]);
  assert.equal(out[0].ok, false);
  assert.match((out[0] as { error: string }).error, /Could not reach the SMS company/);

  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  mockFetch(() => timeout);
  out = await fast2smsProvider.send("1", [msg("a", "9876543210", ["x"])], "AESRIS");
  assert.deepEqual(out, [{ id: "a", ok: false, error: "The SMS company did not answer in time." }]);

  mockFetch(() => ({ status: 502, text: "<html>Bad gateway for 9876543210</html>" }));
  out = await msg91Provider.send("t", [msg("a", "9876543210", ["x"])]);
  const err = (out[0] as { error: string }).error;
  assert.match(err, /answered 502/);
  assert.ok(!err.includes("9876543210") && err.includes("98•••••10"), err);
  assert.ok(!JSON.stringify(out).includes("secret"));
});

test("once the SMS company doesn't answer, the rest of the batch isn't sent to it (tried again later)", async () => {
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  mockFetch(() => timeout);
  const batch = [msg("a", "9876543210", ["x"]), msg("b", "9876543211", ["y"]), msg("c", "9876543212", ["z"])];
  const out = await fast2smsProvider.send("1", batch, "AESRIS");
  assert.equal(calls.length, 1, "one call, not one a message");
  assert.deepEqual(out.map((o) => [o.id, o.ok]), [["a", false], ["b", false], ["c", false]]);
  assert.ok(out.every((o) => !o.ok && o.error === "The SMS company did not answer in time."));

  calls = [];
  mockFetch(() => new TypeError("fetch failed"));
  const many = Array.from({ length: 250 }, (_, i) => msg(`m${i}`, `98765${String(i).padStart(5, "0")}`, ["x"]));
  const out2 = await msg91Provider.send("t", many);
  assert.equal(calls.length, 1);
  assert.equal(out2.length, 250);
  assert.ok(out2.every((o) => !o.ok));
});

test("missing keys or template IDs fail without calling anyone", async () => {
  mockFetch(() => ({ json: { type: "success", message: "x" } }));
  delete process.env.MSG91_AUTH_KEY;
  let out = await msg91Provider.send("t", [msg("a", "9876543210", [])]);
  assert.match((out[0] as { error: string }).error, /MSG91_AUTH_KEY is not set/);
  out = await fast2smsProvider.send(null, [msg("a", "9876543210", [])], "AESRIS");
  assert.match((out[0] as { error: string }).error, /No Fast2SMS message ID/);
  out = await fast2smsProvider.send("1", [msg("a", "9876543210", [])], null);
  assert.match((out[0] as { error: string }).error, /No sender ID for this school: SMS_SENDER_ID is not set/);
  assert.equal(calls.length, 0);
});

test("the log provider sends nothing and prints only a masked number", async () => {
  mockFetch(() => ({ json: {} }));
  const lines: string[] = [];
  const info = console.info;
  console.info = (s: string) => lines.push(s);
  try {
    const out = await logProvider.send(null, [msg("a", "9876543210", ["x"])]);
    assert.deepEqual(out, [{ id: "a", ok: true, ref: null }]);
  } finally {
    console.info = info;
  }
  assert.equal(calls.length, 0);
  assert.ok(lines[0].includes("98•••••10") && !lines[0].includes("9876543210"));
  assert.equal(safeError("x".repeat(400)).length, 300);
});

test("SMS_SENDER_ID: one header for both schools, or one per school; the settings are checked when the server starts", () => {
  process.env.SMS_SENDER_ID = "AESRIS";
  assert.equal(senderIdFor("aryavart"), "AESRIS");
  assert.equal(senderIdFor("aadharshila"), "AESRIS");
  assert.equal(senderIdText(), "AESRIS");
  process.env.SMS_SENDER_ID = "aryavart:ARYAPS, aadharshila:AADHPS";
  assert.equal(senderIdFor("aryavart"), "ARYAPS");
  assert.equal(senderIdFor("aadharshila"), "AADHPS");
  assert.equal(senderIdText(), "aryavart: ARYAPS · aadharshila: AADHPS");

  process.env.SMS_PROVIDER = "fast2sms";
  assert.equal(smsConfigProblem(), null);
  process.env.SMS_SENDER_ID = "aryavart:ARYA";
  assert.match(smsConfigProblem() ?? "", /6-letter sender ID/);
  delete process.env.SMS_SENDER_ID;
  assert.match(smsConfigProblem() ?? "", /fast2sms, but SMS_SENDER_ID is not set/);
  delete process.env.FAST2SMS_API_KEY;
  assert.match(smsConfigProblem() ?? "", /FAST2SMS_API_KEY and SMS_SENDER_ID are not set/);
  process.env.SMS_PROVIDER = "msg91";
  assert.equal(smsConfigProblem(), null, "MSG91 takes the sender ID from its templates");
  delete process.env.MSG91_AUTH_KEY;
  assert.match(smsConfigProblem() ?? "", /MSG91_AUTH_KEY is not set/);
  process.env.SMS_PROVIDER = "twilio";
  assert.match(smsConfigProblem() ?? "", /must be log, msg91 or fast2sms/);

  process.env.SMS_PROVIDER = "log";
  process.env.SMS_PORTAL_ADDRESS = "portal.aesri.org";
  assert.match(smsConfigProblem() ?? "", /SMS_PORTAL_ADDRESS must start with https:\/\//);
  process.env.SMS_PORTAL_ADDRESS = "https://portal.aesri.org/";
  assert.equal(smsConfigProblem(), null);
  assert.equal(smsPortalAddress(), "https://portal.aesri.org");
});
