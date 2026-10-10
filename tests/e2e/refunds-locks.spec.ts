/**
 * Refunds on a student's fee page (principal records one; the receipt and the
 * collections report show it; the accountant can't record one), and sign-in
 * locks: shown with their reason, unlocked by the office, while a phone or
 * computer that signed in before keeps working.
 */
import { expect, test, type Page } from "@playwright/test";
import { axeViolations, PASSWORD, signIn } from "./helpers";

let studentPage = "";

async function openOverdueStudent(page: Page): Promise<string> {
  await page.goto("/office/fees?overdue=1");
  const link = page.locator('a[href^="/office/fees/students/"]').first();
  const href = (await link.getAttribute("href"))!;
  await page.goto(href);
  return href;
}

test("the principal records a refund; the receipt and the collections report show it", async ({ page }) => {
  await signIn(page, "AryaE1");
  studentPage = await openOverdueStudent(page);
  await page.fill("#amount", "1000");
  await page.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText(/₹1,000 received \(cash\)\. Receipt .* is ready to print\./)).toBeVisible();

  // The newest payment is the first row; refund part of it.
  const row = page.locator("section[aria-labelledby='payments-title'] tbody tr").first();
  await row.getByText("Refund…").click();
  await row.locator("input[name=amount]").fill("400");
  await row.locator("input[name=note]").fill("Paid twice by mistake");
  await row.getByRole("button", { name: "Record refund" }).click();
  await row.getByRole("button", { name: "Yes, record refund" }).click();
  await expect(page.getByText(/₹400 refunded \(cash\) on receipt .*\. Refund voucher ARY\/26-27\/RF\d{5}\./)).toBeVisible();
  // A refund's own row starts with its voucher number.
  const refundRow = page.locator("section[aria-labelledby='payments-title'] tbody tr", { hasText: /^ARY\/26-27\/RF\d{5}/ }).first();
  await expect(refundRow).toContainText("−₹400");
  await expect(refundRow).toContainText("Paid twice by mistake");
  expect(await axeViolations(page)).toEqual([]);

  // The receipt keeps what was paid and lists the refund.
  await page.locator("section[aria-labelledby='payments-title'] tbody tr").first().getByRole("link").first().click();
  const receipt = page.locator("article[aria-label^='Fee receipt']");
  await expect(receipt).toContainText("₹1,000");
  await expect(receipt.getByLabel("Refunds on this receipt")).toContainText("₹400");
  await expect(receipt.getByLabel("Refunds on this receipt")).toContainText("₹600");

  // Today's collections: the refund as money paid out, and the net.
  await page.goto("/office/fees/collections");
  await expect(page.locator("tbody tr", { hasText: "Paid twice by mistake" })).toContainText("−₹400");
  await expect(page.getByText("Net received").first()).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // A refund entered by mistake is cancelled: it stays listed, marked, and stops counting.
  await page.goto(studentPage);
  const mistaken = page.locator("section[aria-labelledby='payments-title'] tbody tr", { hasText: /^ARY\/26-27\/RF\d{5}/ }).first();
  await mistaken.getByText("Cancel refund…").click();
  await mistaken.locator("textarea[name=reason]").fill("Entered on the wrong receipt");
  await mistaken.getByRole("button", { name: "Cancel refund", exact: true }).click();
  await mistaken.getByRole("button", { name: "Yes, cancel refund" }).click();
  await expect(page.getByText(/Refund ARY\/26-27\/RF\d{5} \(₹400\) is cancelled\./)).toBeVisible();
  await expect(mistaken).toContainText("Refund cancelled");
  expect(await axeViolations(page)).toEqual([]);
});

test("the accountant sees refunds but can't record one", async ({ page }) => {
  test.skip(!studentPage, "needs the refund test above");
  await signIn(page, "AryaE2");
  await page.goto(studentPage);
  await expect(page.locator("section[aria-labelledby='payments-title'] tbody tr", { hasText: /^ARY\/26-27\/RF\d{5}/ }).first()).toBeVisible();
  await expect(page.getByText("Refund…")).toHaveCount(0);
  await expect(page.getByText(/or record a refund, please ask the principal or office admin/)).toBeVisible();
});

test("a lock shows its reason; a device that signed in before keeps working; the office unlocks it", async ({ page, browser }) => {
  // The teacher's own computer signs in once, then signs out (it stays a known device).
  const own = await browser.newContext();
  const ownPage = await own.newPage();
  await signIn(ownPage, "AryaE3");
  await ownPage.context().clearCookies({ name: /aesri_session/ });

  // Someone else guesses: five wrong passwords lock the login ID from that connection.
  const other = await browser.newContext();
  const op = await other.newPage();
  const tryPassword = async (p: Page, password: string) => {
    await p.goto("/login");
    await p.fill("#loginId", "AryaE3");
    await p.fill("#password", password);
    await p.click('form:has(#loginId) button[type="submit"]');
  };
  for (let i = 0; i < 5; i++) {
    await tryPassword(op, `wrong-guess-${i}`);
    await expect(op.locator("[role=alert]").first()).toContainText(/not right/);
  }
  await tryPassword(op, PASSWORD);
  await expect(op.locator("[role=alert]").first()).toContainText(/Too many wrong tries/);

  // The office sees why it is locked.
  await signIn(page, "AryaE1");
  await page.goto("/office/access?tab=staff&q=AryaE3");
  const teacherRow = page.locator("tr", { hasText: "AryaE3" }).first();
  await expect(teacherRow).toContainText(/Locked after too many wrong tries — until/);

  // The teacher's own computer still signs in.
  await signIn(ownPage, "AryaE3");

  // The office unlocks it; the other connection can sign in again.
  await teacherRow.getByRole("button", { name: /Unlock/ }).click();
  await expect(page.getByText(/Unlocked .*AryaE3.*\. They can try to sign in again now\./)).toBeVisible();
  await signIn(op, "AryaE3");
  await own.close();
  await other.close();
});
