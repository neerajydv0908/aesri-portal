/**
 * After signing in, the portal only ever goes to one of its own pages
 * (lib/auth/next-path.ts), however the ?next= value is crafted.
 *
 *   node --import tsx --test tests/unit/next-path.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { safeNextPath } from "../../lib/auth/next-path";

test("pages on the portal are kept", () => {
  assert.equal(safeNextPath("/my/fees"), "/my/fees");
  assert.equal(safeNextPath("/teach/support?section=abc#how-colours"), "/teach/support?section=abc#how-colours");
});

test("anything that could leave the portal goes home instead", () => {
  for (const s of [
    "",
    "home",
    "https://evil.example/",
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/ /evil.example",
    "\\/evil.example",
    "/%09/evil.example".replace("%09", "\t"),
    "/" + "a".repeat(3000),
  ]) {
    assert.equal(safeNextPath(s), "/home", JSON.stringify(s));
  }
  // Encoded characters stay encoded in the path, so they can't change the origin either.
  assert.equal(new URL(safeNextPath("/%2F%2Fevil.example"), "https://portal.aesri.org").origin, "https://portal.aesri.org");
});
