/**
 * Opening balances mark fees as paid without money passing through the
 * portal, so only the principal and office admins (and AESRI administrators)
 * may record them. This checks the source: every Server Action on the
 * Opening balances page, and the page itself, starts by requiring the
 * administrator roles — never the accounts role. (The browser test
 * tests/e2e/fees-access.spec.ts also checks that the server refuses an
 * accountant's save.)
 *
 *   node --import tsx --test tests/unit/fees-guards.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FEE_ROLES, OFFICE_ROLES } from "../../lib/roles";

const dir = path.join(process.cwd(), "app", "(app)", "office", "fees", "opening");
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");

test("the administrator roles don't include the accountant", () => {
  assert.deepEqual([...OFFICE_ROLES].sort(), ["school_admin", "super_admin"]);
  assert.ok(FEE_ROLES.includes("accounts"));
});

test("every opening-balance action starts by requiring the administrator roles", () => {
  const src = read("actions.ts");
  assert.match(src, /^"use server";/);
  assert.doesNotMatch(src, /FEE_ROLES|requireActor|"accounts"/);
  // Exactly two exports, both actions written as functions (no other way in, such as `export const x = async () =>` or `export { x }`).
  assert.equal(src.match(/\bexport\b/g)?.length, 2);
  const actions = [...src.matchAll(/^export async function (\w+)\([^)]*\)[^{]*\{\n([^\n]*)\n/gm)];
  assert.deepEqual(actions.map((a) => a[1]).sort(), ["markNothingPaidAction", "saveOpeningAction"]);
  for (const [, name, firstLine] of actions) assert.match(firstLine, /= await officePage\(OFFICE_ROLES\);$/, name);
  // Every role check in the file is the administrator one.
  const checks = [...src.matchAll(/officePage\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(checks, ["OFFICE_ROLES", "OFFICE_ROLES"]);
});

test("the page itself requires the administrator roles", () => {
  const src = read("page.tsx");
  assert.doesNotMatch(src, /FEE_ROLES|requireActor|"accounts"/);
  assert.deepEqual([...src.matchAll(/officePage\(([^)]*)\)/g)].map((m) => m[1]), ["OFFICE_ROLES"]);
  const body = src.slice(src.indexOf("export default async function OpeningBalancesPage"));
  const firstAwait = body.slice(body.indexOf("await ")).split("\n")[0];
  assert.equal(firstAwait, "await officePage(OFFICE_ROLES);");
});

/*
 * Approving a cash payment a family recorded issues a receipt without the
 * office having taken the money at its own counter, so only the principal,
 * office admins and AESRI administrators may approve or decline one — never
 * the accountant (who sees such records, without the buttons).
 */
const approvals = path.join(process.cwd(), "app", "(app)", "office", "fees", "approvals");
const readApprovals = (f: string) => fs.readFileSync(path.join(approvals, f), "utf8");

test("every approval action starts by requiring the administrator roles", () => {
  const src = readApprovals("actions.ts");
  assert.match(src, /^"use server";/);
  assert.doesNotMatch(src, /FEE_ROLES|requireActor|"accounts"/);
  assert.equal(src.match(/\bexport\b/g)?.length, 2);
  const actions = [...src.matchAll(/^export async function (\w+)\([^)]*\)[^{]*\{\n([^\n]*)\n/gm)];
  assert.deepEqual(actions.map((a) => a[1]).sort(), ["approveClaimAction", "declineClaimAction"]);
  for (const [, name, firstLine] of actions) assert.match(firstLine, /= await officePage\(OFFICE_ROLES\);$/, name);
});

test("the approvals page itself requires the administrator roles", () => {
  const src = readApprovals("page.tsx");
  assert.doesNotMatch(src, /FEE_ROLES|requireActor|"accounts"/);
  assert.deepEqual([...src.matchAll(/officePage\(([^)]*)\)/g)].map((m) => m[1]), ["OFFICE_ROLES"]);
});
