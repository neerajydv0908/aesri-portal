/**
 * "Needs support" with Stud-AI's estimates: the list shows each student's
 * estimates and colour, a student's page explains them, and families can't
 * reach either. Run with STUD_AI_DIR set (e.g. ../Stud-AI) to check the
 * estimates themselves; without it, the page says Stud-AI isn't set up.
 */
import { expect, test } from "@playwright/test";
import { axeViolations, signIn } from "./helpers";

const withStudAi = !!process.env.STUD_AI_DIR?.trim();

test("the principal sees estimates for every subject, and a student's reasons", async ({ page }) => {
  await signIn(page, "AryaE1");
  await page.goto("/teach/support");
  await expect(page.locator("main h1")).toHaveText("Needs support");
  if (!withStudAi) {
    await expect(page.getByText("No Stud-AI estimates on this server")).toBeVisible();
    return;
  }
  // A class with marks (the demo's youngest classes have none, so they show "No estimate yet").
  await page.getByLabel("Class").selectOption({ label: "IV-A" });
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("heading", { name: "Class IV, section A" })).toBeVisible();
  // Stud-AI runs the first time the page opens: every student with marks gets estimates.
  const first = page.locator("main ul.grid > li").first();
  await expect(first.getByText("Stud-AI, risk of not passing:")).toBeVisible();
  await expect(page.getByText("How the colours are decided").first()).toBeVisible();
  // Four states, each with its word, in the filter.
  const tabs = page.getByRole("navigation", { name: "Sections" });
  for (const word of ["Needs support", "Review needed", "Not enough data yet", "On track"]) {
    await expect(tabs.getByRole("link", { name: new RegExp(`^${word} \\(\\d+\\)$`) })).toBeVisible();
  }
  expect(await axeViolations(page)).toEqual([]);

  await first.getByRole("link", { name: /Details and reasons/ }).click();
  await expect(page.getByRole("heading", { name: "Stud-AI’s estimates" })).toBeVisible();
  // Each subject: the percentage, or "Not enough data as of now" for a subject Stud-AI wasn't trained on.
  const figure = page.getByTestId("studai-estimate").first();
  await expect(figure).toBeVisible();
  expect(await figure.textContent()).toMatch(/^(\d{1,2}%|Not enough data as of now|Review needed)$/);
  const sentence = page.getByText(/^Estimated risk of not passing the next .+ examination: \d{1,2}%$/).first();
  await expect(sentence).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // Opening it again uses the saved estimates (nothing changed): same sentence.
  const text = await sentence.textContent();
  await page.reload();
  await expect(page.getByText(text!).first()).toBeVisible();
});

test("the colour rule and Stud-AI's status are in Settings", async ({ page }) => {
  await signIn(page, "AryaE1");
  await page.goto("/office/settings#support");
  await expect(page.getByText("“Needs support” colours (teachers only)")).toBeVisible();
  await expect(page.locator("#f-riskRedPercent")).toHaveCount(0);
  await expect(page.locator("#f-attendanceRedPercent")).toHaveValue("70");
  await expect(page.locator("#f-concernsRed")).toHaveValue("3");
  await expect(page.locator("#f-concernDays")).toHaveValue("7");
  if (withStudAi) {
    await page.getByRole("button", { name: "Check Stud-AI now" }).click();
    await expect(page.getByText(/Stud-AI passed the check/)).toBeVisible({ timeout: 60_000 });
  } else {
    await expect(page.getByText("Not set up")).toBeVisible();
  }
});

test("families can't open Needs support", async ({ page }) => {
  await signIn(page, "Arya7621");
  for (const href of ["/teach/support"]) {
    await page.goto(href);
    await expect(page, href).toHaveURL(/\/home$/);
  }
});
