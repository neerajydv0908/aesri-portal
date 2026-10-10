/**
 * A family records a cash payment; nothing is paid until the principal
 * approves it (Fees in the menu shows a red dot meanwhile), and then it is an
 * ordinary cash receipt. A declined record tells the family to contact the
 * school. The accountant sees records waiting but can't approve them.
 */
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// Class X-A, nothing paid yet this session in the demo: Term I and Term II of ₹9,000.
const FAMILY = "Arya7660";

test("a recorded cash payment waits for the principal, who approves or declines it", async ({ page, browser, baseURL }) => {
  // The family, in Hindi: too little tuition is refused, then ₹1,500 is recorded.
  await page.context().addCookies([{ name: "lang", value: "hi", url: baseURL! }]);
  await signIn(page, FAMILY);
  await page.goto("/my/fees");
  await page.locator("#tuition").fill("500");
  await page.locator("#how-cash").check();
  await page.getByRole("button", { name: "नकद भुगतान दर्ज करें" }).click();
  await expect(page.locator("form [role=alert]").filter({ hasText: "कम से कम ₹1,000" })).toBeVisible();
  await page.locator("#tuition").fill("1500");
  await page.getByRole("button", { name: "नकद भुगतान दर्ज करें" }).click();
  await expect(page.getByText("आपका नकद भुगतान दर्ज हो गया है।", { exact: false })).toBeVisible();
  await expect(page.locator("#cash-records")).toContainText("स्वीकृति की प्रतीक्षा");

  // The accountant sees it waiting, without the buttons, and can't open the approvals page.
  const acc = await (await browser.newContext({ baseURL })).newPage();
  await signIn(acc, "AryaE2");
  await acc.goto("/office/fees");
  await expect(acc.getByText(/cash payment is waiting for approval/)).toBeVisible();
  await acc.goto("/office/fees/approvals");
  await expect(acc).toHaveURL(/\/home$/);

  // The principal: a red dot on Fees, then Approve.
  const pr = await (await browser.newContext({ baseURL })).newPage();
  await signIn(pr, "AryaE1");
  await expect(pr.locator('nav[data-nav="main"] a[href="/office/fees"]').first()).toContainText("1");
  await pr.goto("/office/fees/approvals");
  await expect(pr.getByText("₹1,500").first()).toBeVisible();
  await pr.getByRole("button", { name: "Approve" }).click();
  await pr.getByRole("button", { name: /Yes — approve and issue receipt/ }).click();
  await expect(pr.getByText("Approved. The receipt is made")).toBeVisible();
  await expect(pr.getByText("Nothing to approve")).toBeVisible();

  // The family now has the receipt and owes ₹1,500 less.
  await page.goto("/my/fees");
  await expect(page.locator("#cash-records")).toContainText("स्वीकृत");
  await expect(page.getByRole("link", { name: /रसीद ARY\/26-27\/\d{5}/ }).first()).toBeVisible();
  await expect(page.getByText("₹16,500").first()).toBeVisible();

  // A second record, declined with a reason the family sees.
  await page.locator("#tuition").fill("2000");
  await page.locator("#how-cash").check();
  await page.getByRole("button", { name: "नकद भुगतान दर्ज करें" }).click();
  await expect(page.getByText("आपका नकद भुगतान दर्ज हो गया है।", { exact: false })).toBeVisible();
  await pr.goto("/office/fees/approvals");
  await pr.locator("textarea[name=reason]").fill("No cash was received that day.");
  await pr.getByRole("button", { name: "Decline" }).click();
  await pr.getByRole("button", { name: "Yes, decline" }).click();
  await expect(pr.getByText(/^Declined\./)).toBeVisible();
  await page.goto("/my/fees");
  await expect(page.locator("#cash-records")).toContainText("अस्वीकृत");
  await expect(page.locator("#cash-records")).toContainText("No cash was received that day.");
  await expect(page.locator("#cash-records")).toContainText("जल्द से जल्द विद्यालय कार्यालय से संपर्क करें");
});
