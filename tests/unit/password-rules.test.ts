/**
 * Password rules (lib/auth/crypto.ts passwordProblem): long enough, and not
 * one of the passwords people try first against guessable login IDs.
 *
 *   node --import tsx --test tests/unit/password-rules.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { passwordProblem } from "../../lib/auth/crypto";

test("ordinary good passwords are accepted", () => {
  for (const p of ["sunny-camel-palana-9", "another-pass-4321", "demo-pass-2026", "मेरा पासवर्ड 2026", "Tea with Ganga at 7"]) {
    assert.equal(passwordProblem(p, "Arya7634"), null, p);
  }
});

test("guessable passwords are refused", () => {
  const cases: [string, string][] = [
    ["short1", "too_short"],
    ["x".repeat(129), "too_long"],
    ["arya7634-home", "contains_id"],
    ["password123", "too_common"],
    ["Password@123", "too_common"],
    ["Aryavart@2026", "too_common"],
    ["aesri#1234", "too_common"],
    ["India@123", "too_common"],
    ["Qwerty@123", "too_common"],
    ["9876543210", "too_common"],
    ["25-05-2012", "too_common"],
    ["P@ssw0rd", "too_common"],
    ["Adm1n@123", "too_common"],
    ["Welc0me@1", "too_common"],
    ["Ary@vart2026", "too_common"],
    ["Sch00l@2026", "too_common"],
    ["1ndia@123", "too_common"],
    ["Qw3rty@123", "too_common"],
    ["Krishn@123", "too_common"],
    ["Indi@123", "too_common"],
    ["Welc0m3@1", "too_common"],
    ["+919876543210", "too_common"],
    ["9876543210@", "too_common"],
    ["(98765)43210", "too_common"],
    ["25-05-2012!", "too_common"],
    ["१२३४५६७८९०", "too_common"],
    ["zzzzzzzzzz", "too_common"],
  ];
  for (const [p, why] of cases) assert.equal(passwordProblem(p, "Arya7634"), why, p);
});

test("long digit passphrases and random symbol mixes are still allowed", () => {
  assert.equal(passwordProblem("4071 9926 3385 1170", "Arya7634"), null);
  assert.equal(passwordProblem("7#2!9$4@1%8^", "Arya7634"), null);
  assert.equal(passwordProblem("S3cure-Garden-77", "Arya7634"), null);
  for (const p of ["राम सीता गीता 7", "Love you mom 2026", "Neelam@Jaipur#88"]) assert.equal(passwordProblem(p, "Arya7634"), null, p);
});
