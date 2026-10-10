"use client";

import { useEffect } from "react";
import { ActionForm } from "@/components/forms";
import { Field, Input, describedBy } from "@/components/ui";
import { PasswordInput, SubmitButton } from "@/components/ui/client";
import { tr, type Lang } from "@/lib/i18n";
import { loginAction } from "../actions";
import { ErrorSummary, SUMMARY_ID, useAuthResult } from "../fields";

export function LoginForm({ lang, next }: { lang: Lang; next?: string }) {
  const t = tr(lang);
  return (
    <ActionForm action={loginAction} messagePosition="none" className="mt-7">
      <ErrorSummary order={["loginId", "password"]} />
      <input type="hidden" name="next" value={next ?? ""} />
      <LoginFields t={t} />
      <SubmitButton size="lg" pendingLabel={t("Signing in…", "साइन इन हो रहा है…")}>
        {t("Sign in", "साइन इन करें")}
      </SubmitButton>
    </ActionForm>
  );
}

function LoginFields({ t }: { t: (en: string, hi: string) => string }) {
  const { fields, keep, nonce } = useAuthResult();
  // A wrong login ID or password: we can't say which, so both boxes are marked and point to the message above.
  const wrong = keep.credentials ? ({ "aria-invalid": true, "aria-describedby": SUMMARY_ID } as const) : null;
  // The login ID stays; the password is typed again.
  useEffect(() => {
    const box = document.getElementById("password") as HTMLInputElement | null;
    if (keep.credentials && box) box.value = "";
  }, [nonce, keep.credentials]);
  return (
    <>
      <Field label={t("Login ID", "लॉगिन आईडी")} htmlFor="loginId" error={fields.loginId} required>
        <Input
          id="loginId"
          name="loginId"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          defaultValue={keep.loginId ?? ""}
          placeholder="Arya7634"
          {...(wrong ?? describedBy("loginId", fields.loginId))}
        />
      </Field>
      <Field label={t("Password", "पासवर्ड")} htmlFor="password" error={fields.password} required>
        <PasswordInput
          id="password"
          name="password"
          autoComplete="current-password"
          required
          showLabel={t("Show password", "पासवर्ड दिखाएँ")}
          hideLabel={t("Hide password", "पासवर्ड छिपाएँ")}
          {...(wrong ?? describedBy("password", fields.password))}
        />
      </Field>
    </>
  );
}
