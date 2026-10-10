/**
 * Translation settings that come from the server's environment (set by
 * whoever runs the server, never shown in the portal). See docs/TRANSLATION.md.
 *
 *   TRANSLATE_PROVIDER         "" (default: off) | azure
 *   AZURE_TRANSLATOR_KEY       Azure portal → the Translator resource → Keys and Endpoint → KEY 1
 *   AZURE_TRANSLATOR_REGION    the resource's region, e.g. centralindia (needed unless the resource is "Global")
 *   AZURE_TRANSLATOR_ENDPOINT  default https://api.cognitive.microsofttranslator.com
 *   TRANSLATE_WAIT_MS          how long a page waits for new translations (default 2500); the rest arrive for the next visit
 *
 * Off, families who chose Hindi see text that was written in English as it
 * was written, marked "written in English".
 */

export type TranslateProviderName = "off" | "azure";

export const TRANSLATE_PROVIDER_LABELS: Record<TranslateProviderName, string> = {
  off: "Off",
  azure: "Microsoft Translator (Azure AI Translator)",
};

export function translateProviderName(): TranslateProviderName {
  return process.env.TRANSLATE_PROVIDER?.trim().toLowerCase() === "azure" ? "azure" : "off";
}

export const DEFAULT_AZURE_ENDPOINT = "https://api.cognitive.microsofttranslator.com";

export function azureSettings(): { key: string; region: string | null; endpoint: string } | null {
  const key = process.env.AZURE_TRANSLATOR_KEY?.trim();
  if (!key) return null;
  return {
    key,
    region: process.env.AZURE_TRANSLATOR_REGION?.trim() || null,
    endpoint: (process.env.AZURE_TRANSLATOR_ENDPOINT?.trim() || DEFAULT_AZURE_ENDPOINT).replace(/\/+$/, ""),
  };
}

/** How long a family's page waits for translations it doesn't have yet (milliseconds, 200–10000). */
export function translateWaitMs(): number {
  const n = Number(process.env.TRANSLATE_WAIT_MS?.trim());
  return Number.isFinite(n) && n >= 200 && n <= 10_000 ? Math.round(n) : 2500;
}

/** What is wrong with the translation settings, in plain words (null: nothing). A production server refuses to start with a problem. */
export function translateConfigProblem(): string | null {
  const raw = process.env.TRANSLATE_PROVIDER?.trim().toLowerCase();
  if (raw && raw !== "azure" && raw !== "off") return `TRANSLATE_PROVIDER must be azure (or empty for no translation), not "${process.env.TRANSLATE_PROVIDER}".`;
  if (translateProviderName() !== "azure") return null;
  const s = azureSettings();
  if (!s) return "TRANSLATE_PROVIDER is azure, but AZURE_TRANSLATOR_KEY is not set (Azure portal → the Translator resource → Keys and Endpoint).";
  if (!/^https:\/\//.test(s.endpoint)) return "AZURE_TRANSLATOR_ENDPOINT must start with https://.";
  if (s.region && !/^[a-z0-9]{2,30}$/.test(s.region)) return `AZURE_TRANSLATOR_REGION should be a region name such as centralindia, not "${s.region}".`;
  return null;
}
