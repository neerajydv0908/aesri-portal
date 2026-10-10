/**
 * Opening balances mark fees as paid without money passing through the
 * portal, so only the principal and office admins (and AESRI administrators)
 * may record them. The accountant can't open the page, doesn't see links to
 * it, and can't save the form even when holding it: the server refuses.
 */
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("the principal can open opening balances", async ({ page }) => {
  await signIn(page, "AryaE1");
  await page.goto("/office/fees");
  await expect(page.getByRole("link", { name: "Opening balances", exact: true }).first()).toBeVisible();
  await page.goto("/office/fees/opening");
  await expect(page.locator("main h1")).toHaveText("Opening balances");
});

test("the accountant can't open or save opening balances", async ({ page, browser, baseURL }) => {
  // The accountant: no link, and the page itself sends them home.
  const accountant = await browser.newContext({ baseURL });
  const acc = await accountant.newPage();
  await signIn(acc, "AryaE2");
  await expect(acc.getByRole("link", { name: "Opening balances", exact: true })).toHaveCount(0);
  await acc.goto("/office/fees");
  await expect(acc.locator("main h1")).toHaveText("Fees");
  await expect(acc.getByRole("link", { name: "Opening balances", exact: true })).toHaveCount(0);
  await acc.goto("/office/fees/opening");
  await expect(acc).toHaveURL(/\/home$/);

  // The principal opens the form for a class with fees still open…
  await signIn(page, "AryaE1");
  await page.goto("/office/fees/opening");
  const sections = await page.locator('select[name="section"] option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
  const box = page.locator('input[name="full"]').first();
  let sectionId: string | null = null;
  for (const id of sections) {
    await page.goto(`/office/fees/opening?section=${id}`);
    if (await box.count()) {
      sectionId = id;
      break;
    }
  }
  expect(sectionId, "a demo class with fees still open").toBeTruthy();
  await expect(box).toBeVisible();
  const chargeId = await box.getAttribute("value");
  expect(chargeId).toBeTruthy();
  const principal = await page.context().cookies();

  // …then the same browser carries the accountant's sign-in and tries to save it.
  await page.context().clearCookies();
  await page.context().addCookies(await accountant.cookies());
  await box.check();
  await page.getByRole("button", { name: "Save opening balances" }).click();
  await expect(page).toHaveURL(/\/home$/);

  // Nothing was recorded: the fee is still open for the principal.
  await page.context().clearCookies();
  await page.context().addCookies(principal);
  await page.goto(`/office/fees/opening?section=${sectionId}`);
  await expect(page.locator(`input[name="full"][value="${chargeId}"]`)).toHaveCount(1);
  await accountant.close();
});
