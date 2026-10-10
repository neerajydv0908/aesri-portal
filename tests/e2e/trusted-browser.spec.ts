/**
 * "Trust this browser for 30 days" (lib/auth/trusted.ts): after the
 * authenticator code with the box ticked, signing in on that browser needs
 * only the password; any other browser still asks for the code; unticking
 * the box, forgetting the browser, or signing out on all other devices (for
 * the other browsers) brings the code back.
 */
import { expect, test } from "@playwright/test";
import { axeViolations, enterCode, signIn, signOut, submitPassword } from "./helpers";

const PRINCIPAL = "AadharE1";
const ACCOUNTANT = "AadharE2";
const trustedTable = (page: import("@playwright/test").Page) => page.getByRole("region", { name: "Browsers trusted for your account" });

test("a trusted browser needs only the password; another browser still asks for the code", async ({ page, browser }) => {
  test.slow();
  await submitPassword(page, PRINCIPAL);
  await expect(page).toHaveURL(/\/login\/2fa/);
  await expect(page.getByRole("checkbox", { name: "Trust this browser for 30 days" })).toBeChecked();
  expect(await axeViolations(page)).toEqual([]);
  await enterCode(page, PRINCIPAL);

  await page.goto("/account");
  await expect(trustedTable(page)).toContainText("This browser");
  expect(await axeViolations(page)).toEqual([]);

  await signOut(page);
  await submitPassword(page, PRINCIPAL);
  await expect(page).toHaveURL(/\/home/);

  const other = await browser.newContext();
  const op = await other.newPage();
  await submitPassword(op, PRINCIPAL);
  await expect(op).toHaveURL(/\/login\/2fa/);
  await other.close();

  await page.goto("/office/log");
  await expect(page.getByText(/Trusted this browser/).first()).toBeVisible();
  await expect(page.getByText(/Signed in on a trusted browser/).first()).toBeVisible();
});

test("with the box unticked, the next sign-in asks for the code again", async ({ page }) => {
  await signIn(page, ACCOUNTANT, undefined, { trust: false });
  await page.goto("/account");
  await expect(page.getByText("No browser is trusted at the moment")).toBeVisible();
  await signOut(page);
  await submitPassword(page, ACCOUNTANT);
  await expect(page).toHaveURL(/\/login\/2fa/);
});

test("signing out on other devices forgets them; forgetting this browser brings the code back", async ({ page, browser }) => {
  test.slow();
  await signIn(page, PRINCIPAL);
  const other = await browser.newContext();
  const op = await other.newPage();
  await signIn(op, PRINCIPAL);

  // From this browser: sign out everywhere else. This one stays trusted, the other doesn't.
  await page.goto("/account");
  await page.getByRole("button", { name: "Sign out on all other devices" }).click();
  await expect(page.getByText(/trusted browsers? on other devices (was|were) forgotten too/)).toBeVisible();
  await expect(trustedTable(page).locator("tbody tr")).toHaveCount(1);
  await expect(trustedTable(page)).toContainText("This browser");
  await submitPassword(op, PRINCIPAL);
  await expect(op).toHaveURL(/\/login\/2fa/);
  await other.close();

  // Forget this browser too.
  await page.getByRole("button", { name: /^Forget .*\(this browser\)$/ }).click();
  await expect(page.getByText(/That browser is no longer trusted/)).toBeVisible();
  await expect(page.getByText("No browser is trusted at the moment")).toBeVisible();
  await signOut(page);
  await submitPassword(page, PRINCIPAL);
  await expect(page).toHaveURL(/\/login\/2fa/);
});
