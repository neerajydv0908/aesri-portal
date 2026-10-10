import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getActor } from "@/lib/auth/dal";
import { logoutAction } from "../../actions";
import { TotpForm } from "./totp-form";

export const metadata: Metadata = { title: "Authenticator code" };

export default async function TwoFactorPage() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.mfaPassed) redirect("/home");
  if (!actor.totpEnabled) redirect("/setup-2fa");
  return (
    <div className="rise-in">
      <p className="eyebrow">Two-step sign-in</p>
      <h1 className="mt-2 text-[2.2rem] text-forest-900">Enter your authenticator code</h1>
      <p className="mt-2 text-muted">Administrator accounts need a second step. Open your authenticator app and type the 6-digit code for “AESRI Portal”.</p>
      <TotpForm mode="verify" />
      <form action={logoutAction} className="mt-8 border-t border-forest-900/10 pt-6">
        <button type="submit" className="text-[0.95rem] font-semibold text-forest-800 underline-offset-4 hover:underline">
          Not you? Sign out
        </button>
      </form>
    </div>
  );
}
