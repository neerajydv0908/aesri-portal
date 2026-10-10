/**
 * The first sign-in: the office prints a slip, the family activates with the
 * one-time code and signs in with their own password; the code works once.
 */
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("print a slip, activate, sign in", async ({ page, browser }) => {
  await signIn(page, "AryaE1");
  await page.goto("/office/access");
  const va = await page.locator("#pick-section option", { hasText: /^V-A$/ }).getAttribute("value");
  await page.goto(`/office/access?section=${va}`);
  await page.getByRole("button", { name: /Print slips for everyone not yet activated in V-A/ }).click();
  const slip = page.locator("article[aria-label^='Slip for']").first();
  await expect(slip).toBeVisible();
  const text = (await slip.innerText()).replace(/\s+/g, " ");
  const code = text.match(/\b[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}\b/)?.[0];
  const loginId = text.match(/\b(Arya\d+)\b/)?.[1];
  expect(code && loginId).toBeTruthy();

  const family = await browser.newContext();
  const fp = await family.newPage();
  await fp.goto(`/activate?id=${loginId}`);
  await expect(fp.locator("#loginId")).toHaveValue(loginId!);
  await fp.fill("#code", code!);
  await fp.fill("#password", "sunny-camel-palana-9");
  await fp.fill("#confirm", "sunny-camel-palana-9");
  await fp.check("#privacy");
  await fp.getByRole("button", { name: /Activate/ }).click();
  await expect(fp).toHaveURL(/\/home/);

  const again = await browser.newContext();
  const ap = await again.newPage();
  await ap.goto(`/activate?id=${loginId}`);
  await ap.fill("#code", code!);
  await ap.fill("#password", "another-pass-4321");
  await ap.fill("#confirm", "another-pass-4321");
  await ap.check("#privacy");
  await ap.getByRole("button", { name: /Activate/ }).click();
  await expect(ap.locator("[role=alert]").first()).toContainText(/don't match|expired|already been used/);

  const signin = await browser.newContext();
  const sp = await signin.newPage();
  await signIn(sp, loginId!, "sunny-camel-palana-9");
});
