/**
 * Every page in each role's menu opens without errors, passes axe (WCAG 2.2
 * AA) and doesn't scroll sideways on a phone.
 */
import { expect, test } from "@playwright/test";
import { axeViolations, signIn } from "./helpers";

const ROLES = [
  { id: "aesri.demo", name: "AESRI administrator" },
  { id: "AryaE1", name: "principal" },
  { id: "AryaE2", name: "accountant" },
  { id: "AryaE3", name: "teacher" },
  { id: "Arya7621", name: "family (English)" },
  { id: "Arya7621", name: "family (Hindi)", lang: "hi" },
];

for (const role of ROLES) {
  test(`${role.name}: every menu page works`, async ({ page, context, baseURL }) => {
    // The development server builds each page on its first visit: the administrator's long menu can take over two minutes.
    test.slow();
    if (role.lang) await context.addCookies([{ name: "lang", value: role.lang, url: baseURL! }]);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !m.text().includes("status of 404") && errors.push(m.text()));
    await signIn(page, role.id);
    const links = await page.locator('nav[data-nav="main"] a[href^="/"]').evaluateAll((as) => [...new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!))]);
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const href of links) {
      const res = await page.goto(href);
      expect(res?.status(), href).toBeLessThan(400);
      await expect(page.locator("main h1").first(), href).toBeVisible();
      expect(await axeViolations(page), href).toEqual([]);
      await page.setViewportSize({ width: 390, height: 844 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${href} at 390 px`).toBeLessThanOrEqual(1);
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    expect(errors).toEqual([]);
  });
}

test("a family can't open office or teacher pages", async ({ page }) => {
  await signIn(page, "Arya7621");
  for (const href of ["/office/students", "/office/fees", "/teach/attendance", "/aesri"]) {
    await page.goto(href);
    await expect(page, href).toHaveURL(/\/home$/);
  }
});
