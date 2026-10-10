import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { LogOut, MonitorCheck, ShieldCheck, ShieldAlert } from "lucide-react";
import { Flash } from "@/components/flash";
import { ActionForm } from "@/components/forms";
import { Badge, Card, CardTitle, PageHeader, Table, Td, Th } from "@/components/ui";
import { InfoList } from "@/components/access/info-list";
import { SubmitButton } from "@/components/ui/client";
import { getDb } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { getActor, requireActor } from "@/lib/auth/dal";
import { listTrustedBrowsers, TRUST_DAYS } from "@/lib/auth/trusted";
import { thisBrowserTrustId } from "@/lib/auth/trusted-browser";
import { formatDate, formatDateTime, todayIST } from "@/lib/dates";
import { tr, type Lang } from "@/lib/i18n";
import { getLang } from "@/lib/i18n/server";
import { needsTwoFactor, roleLabel } from "@/lib/roles";
import { otherSessionCount } from "@/lib/services/accounts";
import { changePasswordAction, forgetAllTrustedBrowsersAction, forgetTrustedBrowserAction, signOutOthersAction } from "./actions";
import { PasswordField } from "./fields";

export async function generateMetadata(): Promise<Metadata> {
  const actor = await getActor();
  const hi = actor?.role === "student" && (await getLang()) === "hi";
  return { title: hi ? "आपका खाता" : "Your account" };
}

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ done?: string }> }) {
  const actor = await requireActor();
  const sp = await searchParams;
  const family = actor.role === "student";
  const lang: Lang = family ? await getLang() : "en";
  const t = tr(lang);
  const db = await getDb();
  const [acc] = await db
    .select({
      id: accounts.id,
      status: accounts.status,
      lastLoginAt: accounts.lastLoginAt,
      passwordChangedAt: accounts.passwordChangedAt,
      totpEnabled: accounts.totpEnabled,
      totpSecretEnc: accounts.totpSecretEnc,
    })
    .from(accounts)
    .where(eq(accounts.id, actor.accountId));
  const others = await otherSessionCount(db, actor.accountId, actor.sessionId);
  const admin = needsTwoFactor(actor.role);
  // Browsers trusted after the authenticator code (lib/auth/trusted.ts): administrators only.
  const trusted = admin && acc ? await listTrustedBrowsers(db, acc) : [];
  const here = admin ? await thisBrowserTrustId(actor.accountId) : null;
  const show = t("Show password", "पासवर्ड दिखाएँ");
  const hide = t("Hide password", "पासवर्ड छिपाएँ");
  const lostPhone =
    actor.role === "super_admin"
      ? "Lost your phone? Ask another AESRI administrator for a new slip. It resets your password and your authenticator app, and you set both up again."
      : actor.role === "school_admin"
        ? "Lost your phone? Ask an AESRI administrator for a new slip. It resets your password and your authenticator app, and you set both up again."
        : "Lost your phone? Ask the principal or school office for a new slip. It resets your password and your authenticator app, and you set both up again.";

  return (
    <>
      <PageHeader
        eyebrow={t("Your account", "आपका खाता")}
        title={t("Password and sign-in", "पासवर्ड और साइन-इन")}
        description={
          family
            ? t("Change the password you use to sign in, and sign out on devices you no longer use.", "साइन इन का पासवर्ड बदलें, और उन डिवाइसों पर साइन आउट करें जिन्हें अब आप उपयोग नहीं करते।")
            : admin
              ? "Change your password, sign out on devices you no longer use, and choose which browsers you trust."
              : "Change your password, and sign out on devices you no longer use."
        }
      />
      {admin ? (
        <Flash
          code={sp.done}
          messages={{
            browser_forgotten: "That browser is no longer trusted: signing in there asks for your authenticator code again.",
            browsers_forgotten: "No browser is trusted any more: your next sign-in asks for your authenticator code, on this browser too.",
          }}
        />
      ) : null}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardTitle>{t("Your sign-in", "आपका साइन-इन")}</CardTitle>
          <InfoList
            items={[
              { label: t("Login ID", "लॉगिन आईडी"), value: <span className="font-semibold tabular">{actor.loginId}</span> },
              { label: t("Account", "खाता"), value: `${actor.name} · ${roleLabel(actor.role, lang)}` },
              {
                label: t("Last sign-in", "पिछला साइन-इन"),
                value: acc?.lastLoginAt ? formatDateTime(acc.lastLoginAt, lang) : t("Not recorded yet", "अभी दर्ज नहीं"),
              },
              {
                label: t("Password chosen", "पासवर्ड चुना गया"),
                value: acc?.passwordChangedAt ? formatDate(todayIST(acc.passwordChangedAt), lang) : "—",
              },
              ...(admin
                ? [
                    {
                      label: "Authenticator app",
                      value: acc?.totpEnabled ? (
                        <span className="grid justify-items-start gap-1.5">
                          <Badge tone="green">
                            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                            On
                          </Badge>
                          <span className="text-[0.92rem] text-forest-900/85">
                            You enter a code from the app when you sign in. On a browser you trust, it is asked for once every {TRUST_DAYS} days. {lostPhone}
                          </span>
                        </span>
                      ) : (
                        <span className="grid justify-items-start gap-1.5">
                          <Badge tone="amber">
                            <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
                            Not set up
                          </Badge>
                          <span className="text-[0.92rem] text-forest-900/85">You will be asked to set it up the next time you sign in.</span>
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </Card>

        <Card>
          <CardTitle>{t("Change your password", "पासवर्ड बदलें")}</CardTitle>
          <ActionForm action={changePasswordAction} resetOnSuccess aria-label={t("Change your password", "पासवर्ड बदलें")} className="gap-4">
            {/* Lets password managers save the new password against the right login ID. */}
            <input type="text" name="username" autoComplete="username" value={actor.loginId} readOnly hidden />
            <PasswordField name="currentPassword" label={t("Current password", "वर्तमान पासवर्ड")} autoComplete="current-password" showLabel={show} hideLabel={hide} />
            <PasswordField
              name="newPassword"
              label={t("New password", "नया पासवर्ड")}
              hint={t(
                "At least 8 characters, without your login ID. Three random words are easy to remember and hard to guess.",
                "कम से कम 8 अक्षर, लॉगिन आईडी के बिना। तीन अलग-अलग शब्द याद रखने में आसान और अनुमान लगाने में कठिन होते हैं।",
              )}
              autoComplete="new-password"
              showLabel={show}
              hideLabel={hide}
            />
            <PasswordField name="confirmPassword" label={t("Type the new password again", "नया पासवर्ड दोबारा लिखें")} autoComplete="new-password" showLabel={show} hideLabel={hide} />
            <p className="text-[0.9rem] text-muted">
              {t("You stay signed in here. Any other devices are signed out.", "इस डिवाइस पर आप साइन इन रहेंगे। बाकी सभी डिवाइसों पर साइन आउट हो जाएगा।")}
            </p>
            <div>
              <SubmitButton pendingLabel={t("Changing…", "बदला जा रहा है…")}>{t("Change password", "पासवर्ड बदलें")}</SubmitButton>
            </div>
          </ActionForm>
        </Card>

        <Card className="lg:col-span-2">
          <CardTitle>{t("Other devices", "अन्य डिवाइस")}</CardTitle>
          <ActionForm action={signOutOthersAction} aria-label={t("Sign out on all other devices", "अन्य सभी डिवाइसों पर साइन आउट करें")} className="gap-4">
            <p className="max-w-2xl text-forest-900/85">
              {others
                ? t(
                    `You are also signed in on ${others === 1 ? "1 other device or browser" : `${others} other devices or browsers`}. If one of them isn’t yours, or you have lost it, sign out there now and change your password.`,
                    `आप ${others} अन्य ${others === 1 ? "डिवाइस या ब्राउज़र" : "डिवाइसों या ब्राउज़रों"} पर भी साइन इन हैं। यदि उनमें से कोई आपका नहीं है या खो गया है, तो वहाँ अभी साइन आउट करें और पासवर्ड बदलें।`,
                  )
                : t("You are not signed in on any other device or browser.", "आप किसी अन्य डिवाइस या ब्राउज़र पर साइन इन नहीं हैं।")}
              {admin ? " Signing out there also forgets them as trusted browsers, so they will need the authenticator code again." : ""}
            </p>
            <div>
              <SubmitButton variant="secondary" pendingLabel={t("Signing out…", "साइन आउट हो रहा है…")}>
                <LogOut className="h-4 w-4" aria-hidden />
                {t("Sign out on all other devices", "अन्य सभी डिवाइसों पर साइन आउट करें")}
              </SubmitButton>
            </div>
          </ActionForm>
        </Card>

        {admin && acc?.totpEnabled ? (
          <Card className="lg:col-span-2">
            <CardTitle>Trusted browsers</CardTitle>
            <div className="grid gap-4">
              <p className="max-w-2xl text-forest-900/85">
                When you tick “Trust this browser for {TRUST_DAYS} days” with your authenticator code, signing in on that browser needs only your password until the date
                shown. Forget any browser you no longer use, or any that isn’t yours.
              </p>
              {trusted.length ? (
                <>
                  <Table caption="Browsers trusted for your account">
                    <thead>
                      <tr>
                        <Th>Browser</Th>
                        <Th>Trusted on</Th>
                        <Th>Until</Th>
                        <Th>Last used to sign in</Th>
                        <Th>
                          <span className="sr-only">Forget</span>
                        </Th>
                      </tr>
                    </thead>
                    <tbody>
                      {trusted.map((b) => {
                        const label = b.browser;
                        const trustedOn = formatDateTime(b.createdAt, "en");
                        return (
                          <tr key={b.id}>
                            <Td>
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="font-semibold text-forest-900">{label}</span>
                                {b.id === here ? (
                                  <Badge tone="green">
                                    <MonitorCheck className="h-3.5 w-3.5" aria-hidden />
                                    This browser
                                  </Badge>
                                ) : null}
                              </span>
                            </Td>
                            <Td>{trustedOn}</Td>
                            <Td>{formatDate(todayIST(b.expiresAt), "en")}</Td>
                            <Td>{b.lastUsedAt ? formatDateTime(b.lastUsedAt, "en") : "Not yet"}</Td>
                            <Td className="text-right">
                              <form action={forgetTrustedBrowserAction}>
                                <input type="hidden" name="id" value={b.id} />
                                <SubmitButton variant="secondary" size="sm" pendingLabel="Forgetting…" aria-label={`Forget ${label}, trusted ${trustedOn}${b.id === here ? " (this browser)" : ""}`}>
                                  Forget
                                </SubmitButton>
                              </form>
                            </Td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </Table>
                  <form action={forgetAllTrustedBrowsersAction}>
                    <SubmitButton variant="secondary" pendingLabel="Forgetting…">
                      Forget all trusted browsers
                    </SubmitButton>
                  </form>
                </>
              ) : (
                <p className="max-w-2xl text-forest-900/85">No browser is trusted at the moment, so every sign-in asks for your authenticator code.</p>
              )}
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
