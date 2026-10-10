"use client";

import { ActionForm } from "@/components/forms";
import { Checkbox, Field, Input, describedBy } from "@/components/ui";
import { SubmitButton } from "@/components/ui/client";
import { confirmTotpSetupAction, verifyTotpAction } from "../../actions";
import { ErrorSummary, useAuthResult } from "../../fields";

/** The authenticator code. A wrong code is cleared and the box focused, with the problem read out with it. */
export function TotpForm({ mode }: { mode: "verify" | "setup" }) {
  return (
    <ActionForm action={mode === "verify" ? verifyTotpAction : confirmTotpSetupAction} messagePosition="none" className="mt-7">
      <ErrorSummary focusField="code" />
      <CodeField />
      <TrustBox />
      <SubmitButton size="lg" pendingLabel="Checking…">
        {mode === "verify" ? "Continue" : "Turn on two-step sign-in"}
      </SubmitButton>
    </ActionForm>
  );
}

function CodeField() {
  const { fields } = useAuthResult();
  return (
    <Field label="6-digit code" htmlFor="code" error={fields.code} required>
      <Input
        id="code"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]*"
        maxLength={7}
        required
        className="max-w-[12rem] text-center text-xl font-semibold tracking-[0.3em] tabular"
        placeholder="123456"
        {...describedBy("code", fields.code)}
      />
    </Field>
  );
}

/** "Trust this browser for 30 days" (lib/auth/trusted.ts): ticked unless the person unticks it; kept after a wrong code. */
function TrustBox() {
  const { keep } = useAuthResult();
  return (
    <div className="grid gap-1.5">
      <Checkbox name="trust" value="yes" defaultChecked={keep.trust ?? true} aria-describedby="trust-hint" label={<span className="font-semibold">Trust this browser for 30 days</span>} />
      <p id="trust-hint" className="pl-9 text-[0.9rem] text-muted">
        Signing in on this browser will then need only your password. Untick this on a shared or public computer.
      </p>
    </div>
  );
}
