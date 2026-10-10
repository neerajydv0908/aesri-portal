import type { Metadata } from "next";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { getActor, isAdminRole } from "@/lib/auth/dal";
import { pendingTotpSetup } from "@/lib/auth/totp";
import { logoutAction } from "../actions";
import { TotpForm } from "../login/2fa/totp-form";

export const metadata: Metadata = { title: "Set up two-step sign-in" };

export default async function SetupTwoFactorPage() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (!isAdminRole(actor.role)) redirect("/home");
  if (actor.totpEnabled) redirect(actor.mfaPassed ? "/home" : "/login/2fa");
  const setup = await pendingTotpSetup();
  if (!setup) redirect("/login");
  const qr = await QRCode.toString(setup.uri, { type: "svg", margin: 1, color: { dark: "#13271c", light: "#fcfaf5" } });
  const qrSrc = `data:image/svg+xml;base64,${Buffer.from(qr).toString("base64")}`;
  return (
    <div className="rise-in">
      <p className="eyebrow">One-time setup</p>
      <h1 className="mt-2 text-[2.1rem] text-forest-900">Protect your administrator account</h1>
      <p className="mt-2 text-muted">
        Administrators can see every record in a school, so they sign in with a password <em>and</em> a code from an authenticator app on their phone.
      </p>
      <ol className="mt-6 grid gap-4 text-[0.97rem] text-forest-900">
        <li>
          <span className="font-semibold">1. Install an authenticator app</span> — for example Google Authenticator or Microsoft Authenticator.
        </li>
        <li>
          <span className="font-semibold">2. Scan this code</span> with the app, or type the key by hand.
          <div className="mt-3 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrSrc} alt="QR code for the authenticator app" width={176} height={176} className="rounded-xl ring-1 ring-forest-900/10" />
            <div>
              <p className="eyebrow">Key</p>
              <p className="mt-1 font-mono text-[0.95rem] tracking-wider text-forest-900 break-all">{setup.secret}</p>
            </div>
          </div>
        </li>
        <li>
          <span className="font-semibold">3. Enter the 6-digit code</span> the app shows.
        </li>
      </ol>
      <TotpForm mode="setup" />
      <form action={logoutAction} className="mt-8 border-t border-forest-900/10 pt-6">
        <button type="submit" className="text-[0.95rem] font-semibold text-forest-800 underline-offset-4 hover:underline">
          Sign out and do this later
        </button>
      </form>
    </div>
  );
}
