import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { Secret, TOTP } from "otpauth";

export const PASSWORD = "demo-pass-2026";
const totp = new TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP") });
const lastStep = new Map<string, number>();

/**
 * Sign in as a demo account; admin-type accounts also get the authenticator
 * code, unless the browser is already trusted for them. "Trust this browser"
 * is left as it is (ticked) unless `trust` says otherwise.
 */
export async function signIn(page: Page, loginId: string, password = PASSWORD, opts: { trust?: boolean } = {}) {
  await submitPassword(page, loginId, password);
  if (page.url().includes("/login/2fa")) await enterCode(page, loginId, opts);
  await expect(page).toHaveURL(/\/home/);
}

/** The sign-in form only: ends on /home, or on /login/2fa when the code is still needed. */
export async function submitPassword(page: Page, loginId: string, password = PASSWORD) {
  await page.goto("/login");
  await page.fill("#loginId", loginId);
  await page.fill("#password", password);
  await page.click('form:has(#loginId) button[type="submit"]');
  await page.waitForURL((u) => u.pathname === "/home" || u.pathname.startsWith("/login/2fa"));
}

/** On the two-step page: the current authenticator code, with "Trust this browser" set as asked. */
export async function enterCode(page: Page, loginId: string, { trust }: { trust?: boolean } = {}) {
  // A code can be used once per 30-second step and account.
  if (lastStep.get(loginId) === Math.floor(Date.now() / 30_000)) await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
  lastStep.set(loginId, Math.floor(Date.now() / 30_000));
  await page.fill("#code", totp.generate());
  if (trust !== undefined) await page.setChecked('input[name="trust"]', trust);
  await page.click('form:has(#code) button[type="submit"]');
  await page.waitForURL(/\/home/);
}

/** The "Sign out" button in the menu. */
export async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out", exact: true }).first().click();
  await page.waitForURL(/\/login/);
}

/** WCAG 2.2 AA checks with axe; returns readable violations. */
export async function axeViolations(page: Page): Promise<string[]> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 5_000 }).catch(() => {});
  // @axe-core/playwright is typed against its own copy of Playwright; the page is the same object.
  const r = await new AxeBuilder({ page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]["page"] }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}
