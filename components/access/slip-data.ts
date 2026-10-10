/**
 * Turns freshly issued codes into printable slips (server only): the
 * organisation's names, the portal address and a QR code that opens the
 * activation page with the login ID filled in. The QR code never carries
 * the one-time code.
 */
import "server-only";
import QRCode from "qrcode";
import { todayIST } from "@/lib/dates";
import { appUrl } from "@/lib/env";
import { needsTwoFactor } from "@/lib/roles";
import { ACCESS_LABELS } from "@/lib/roles";
import type { IssuedCode, SlipTarget } from "@/lib/services/accounts";
import type { SlipBatch, SlipData } from "./slip-types";

/** The address printed on slips: the activation page, without "https://". */
export function activationAddress(): string {
  return `${appUrl().replace(/^https:\/\//, "")}/activate`;
}

export async function qrFor(loginId: string): Promise<string> {
  const svg = await QRCode.toString(`${appUrl()}/activate?id=${encodeURIComponent(loginId)}`, {
    type: "svg",
    margin: 0,
    errorCorrectionLevel: "M",
    color: { dark: "#000000", light: "#ffffff" },
  });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function detailFor(t: SlipTarget): string | null {
  switch (t.person.kind) {
    case "student":
      return t.person.sectionLong ?? "Student";
    case "staff":
      return t.person.designation ?? ACCESS_LABELS[t.person.access];
    default:
      return "AESRI administrator";
  }
}

export async function buildSlipBatch(org: SlipBatch["org"], issued: IssuedCode[], targets: SlipTarget[]): Promise<SlipBatch> {
  const byId = new Map(targets.map((t) => [t.accountId, t]));
  const slips: SlipData[] = [];
  for (const c of issued) {
    const t = byId.get(c.accountId);
    if (!t) continue;
    slips.push({
      loginId: c.loginId,
      name: t.person.name,
      detail: detailFor(t),
      code: c.code,
      validUntil: todayIST(c.expiresAt),
      qr: await qrFor(c.loginId),
      admin: needsTwoFactor(t.role),
      reset: c.purpose === "reset",
    });
  }
  return { org, address: activationAddress(), slips };
}
