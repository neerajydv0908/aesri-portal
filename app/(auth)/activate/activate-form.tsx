"use client";

import clsx from "clsx";
import { ActionForm } from "@/components/forms";
import { Checkbox, Field, Input, describedBy } from "@/components/ui";
import { PasswordInput, SubmitButton } from "@/components/ui/client";
import { tr, type Lang } from "@/lib/i18n";
import { activateAction } from "../actions";
import { ErrorSummary, useAuthResult } from "../fields";

/**
 * First sign-in with the slip. When something needs fixing, everything
 * typed stays in the boxes (the code and the tick too) and each problem is
 * shown at its box as well as in the summary at the top.
 */
export function ActivateForm({ lang, loginId }: { lang: Lang; loginId: string }) {
  const t = tr(lang);
  return (
    <ActionForm action={activateAction} messagePosition="none" className="mt-7">
      <ErrorSummary order={["loginId", "code", "password", "confirm", "privacy"]} />
      <ActivateFields t={t} loginId={loginId} />
      <SubmitButton size="lg" pendingLabel={t("Activating…", "सक्रिय हो रहा है…")}>
        {t("Activate and sign in", "सक्रिय करें और साइन इन करें")}
      </SubmitButton>
    </ActionForm>
  );
}

function ActivateFields({ t, loginId }: { t: (en: string, hi: string) => string; loginId: string }) {
  const { fields, keep } = useAuthResult();
  const show = t("Show password", "पासवर्ड दिखाएँ");
  const hide = t("Hide password", "पासवर्ड छिपाएँ");
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
          defaultValue={keep.loginId ?? loginId}
          placeholder="Arya7634"
          {...describedBy("loginId", fields.loginId)}
        />
      </Field>
      <Field label={t("One-time code", "एक-बार वाला कोड")} htmlFor="code" hint={t("8 letters and numbers, like K7MQ-29XP", "8 अक्षर और अंक, जैसे K7MQ-29XP")} error={fields.code} required>
        <Input
          id="code"
          name="code"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          required
          className="font-semibold uppercase tracking-[0.15em]"
          placeholder="XXXX-XXXX"
          {...describedBy("code", fields.code, true)}
        />
      </Field>
      <Field
        label={t("Choose a password", "पासवर्ड चुनें")}
        htmlFor="password"
        hint={t("At least 8 characters. Three random words are easy to remember and hard to guess.", "कम से कम 8 अक्षर। तीन अलग-अलग शब्द याद रखने में आसान और अनुमान लगाने में कठिन होते हैं।")}
        error={fields.password}
        required
      >
        <PasswordInput id="password" name="password" autoComplete="new-password" required minLength={8} showLabel={show} hideLabel={hide} {...describedBy("password", fields.password, true)} />
      </Field>
      <Field label={t("Type the password again", "पासवर्ड दोबारा लिखें")} htmlFor="confirm" error={fields.confirm} required>
        <PasswordInput id="confirm" name="confirm" autoComplete="new-password" required minLength={8} showLabel={show} hideLabel={hide} {...describedBy("confirm", fields.confirm)} />
      </Field>

      <div className={clsx("rounded-2xl bg-sage-50 p-4 text-[0.92rem] text-forest-900", fields.privacy ? "ring-2 ring-clay-500" : "ring-1 ring-forest-700/15")}>
        <p className="font-semibold">{t("Privacy notice", "गोपनीयता सूचना")}</p>
        <p className="mt-1.5 text-forest-900/85">
          {t(
            "The school uses this portal to share attendance, marks, homework, fees and notices. A child's records can be seen only by the family using this account and by the school staff who need them. Nothing is used for advertising.",
            "विद्यालय इस पोर्टल से उपस्थिति, अंक, गृहकार्य, फ़ीस और सूचनाएँ साझा करता है। बच्चे के रिकॉर्ड केवल इस खाते का उपयोग करने वाला परिवार और ज़रूरत वाले विद्यालय स्टाफ़ ही देख सकते हैं। किसी भी जानकारी का उपयोग विज्ञापन के लिए नहीं होता।",
          )}{" "}
          <a href="/privacy" target="_blank" rel="noopener" className="font-semibold underline underline-offset-2">
            {t("Read the full privacy notice", "पूरी गोपनीयता सूचना पढ़ें")}
            <span className="sr-only">{t(" (opens in a new tab)", " (नए टैब में खुलेगा)")}</span>
          </a>
        </p>
        <Checkbox
          id="privacy"
          name="privacy"
          value="yes"
          required
          defaultChecked={keep.privacy ?? false}
          className="mt-3"
          label={t("I have read this notice.", "मैंने यह सूचना पढ़ ली है।")}
          {...describedBy("privacy", fields.privacy)}
        />
        {fields.privacy ? (
          <p id="privacy-error" className="mt-1.5 text-[0.85rem] font-semibold text-clay-600">
            {fields.privacy}
          </p>
        ) : null}
      </div>
    </>
  );
}
