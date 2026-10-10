import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { KeyRound, Phone, School, Smartphone } from "lucide-react";
import { familyPage } from "@/lib/page";
import { getLang } from "@/lib/i18n/server";
import { classLabel, classLabelHi } from "@/lib/classes";
import { formatDate } from "@/lib/dates";
import { familyRecord } from "@/lib/queries/records";
import { schoolSmsSettings, studentSmsInfo } from "@/lib/queries/sms";
import { maskMobile, validMobile } from "@/lib/sms/templates";
import { Alert, ButtonLink, Card, CardTitle, PageHeader } from "@/components/ui";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getLang()) === "hi" ? "प्रोफ़ाइल" : "Profile" };
}

export default async function MyProfilePage() {
  const ctx = await familyPage();
  const { t, lang } = ctx;
  const [s, smsInfo, smsSettings] = await Promise.all([familyRecord(ctx.studentId), studentSmsInfo(ctx.schoolId, ctx.studentId), schoolSmsSettings(ctx.schoolId)]);
  if (!s) notFound();
  // Where the school's text messages go (numbers masked: the family knows its own numbers).
  const smsNumbers = smsInfo
    ? [validMobile(smsInfo.guardianMobile), smsSettings.alsoSecondMobile ? validMobile(smsInfo.mobile2) : null].filter((m, i, all): m is string => !!m && all.indexOf(m) === i)
    : [];
  const masked = (m: string) => (
    <span className="whitespace-nowrap font-semibold tabular">
      <span aria-hidden>{maskMobile(m)}</span>
      <span className="sr-only">{t(`the mobile number ending ${m.slice(-2)}`, `${m.slice(-2)} पर समाप्त होने वाला मोबाइल नंबर`)}</span>
    </span>
  );
  const p = ctx.placement;
  const schoolName = lang === "hi" ? ctx.school.nameHi : ctx.school.name;
  // Small-caps labels suit English; Devanagari gets a larger, plain label.
  const labelClass = lang === "hi" ? "text-[0.92rem] font-semibold text-muted" : "eyebrow";
  const none = <span className="text-muted">{t("Not recorded", "दर्ज नहीं")}</span>;
  const phone = (n: string | null) =>
    n ? (
      <a href={`tel:+91${n}`} className="inline-flex min-h-6 items-center gap-1.5 tabular underline-offset-2 hover:underline">
        <Phone className="h-3.5 w-3.5 text-muted" aria-hidden />
        {n}
      </a>
    ) : (
      none
    );

  const items: { label: string; value: ReactNode }[] = [
    { label: t("Name", "नाम"), value: s.name },
    { label: t("SR no.", "एस.आर. नंबर"), value: <span className="tabular">{s.srNo}</span> },
    { label: t("Login ID", "लॉगिन आईडी"), value: <span className="tabular">{ctx.actor.loginId}</span> },
    {
      label: t("Class", "कक्षा"),
      value: p ? (lang === "hi" ? classLabelHi(p.className, p.stream, p.sectionName) : classLabel(p.className, p.stream, p.sectionName)) : t("Not in a class yet this session", "इस सत्र में अभी किसी कक्षा में नहीं"),
    },
    { label: t("Roll no.", "रोल नंबर"), value: p?.rollNo ? <span className="tabular">{p.rollNo}</span> : none },
    { label: t("Date of birth", "जन्म तिथि"), value: s.dob ? formatDate(s.dob, lang) : none },
    { label: t("Father’s name", "पिता का नाम"), value: s.fatherName ?? none },
    { label: t("Mother’s name", "माता का नाम"), value: s.motherName ?? none },
    ...(s.guardianName ? [{ label: t("Guardian’s name", "संरक्षक का नाम"), value: s.guardianName }] : []),
    { label: t("Parent’s mobile", "माता-पिता का मोबाइल"), value: phone(s.guardianMobile) },
    { label: t("Second mobile", "दूसरा मोबाइल"), value: phone(s.mobile2) },
    { label: t("Village or address", "गाँव या पता"), value: s.address ?? none },
    { label: t("RTE seat", "RTE सीट"), value: s.rte ? t("Yes — no fees are charged", "हाँ — कोई फ़ीस नहीं ली जाती") : t("No", "नहीं") },
  ];

  return (
    <>
      <PageHeader
        eyebrow={<span className={lang === "hi" ? "text-[0.95rem]" : undefined}>{schoolName}</span>}
        title={t("Profile", "प्रोफ़ाइल")}
        description={t("Your child’s details as the school has them.", "विद्यालय में दर्ज आपके बच्चे का विवरण।")}
      />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <Card>
          <CardTitle>{t("Student’s details", "विद्यार्थी का विवरण")}</CardTitle>
          <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
            {items.map((it) => (
              <div key={it.label}>
                <dt className={labelClass}>{it.label}</dt>
                <dd className="mt-1 text-[1rem] text-forest-900">{it.value}</dd>
              </div>
            ))}
          </dl>
          <Alert tone="blue" className="mt-6">
            {t("If anything here is wrong, please tell the school office — they will correct it.", "यदि इसमें कुछ भी गलत है, तो कृपया विद्यालय कार्यालय को बताएँ — वे इसे ठीक कर देंगे।")}
          </Alert>
        </Card>

        <div className="grid min-w-0 gap-6">
          <Card>
            <CardTitle>{t("School", "विद्यालय")}</CardTitle>
            <p className="flex items-start gap-2 font-semibold text-forest-900">
              <School className="mt-1 h-4 w-4 shrink-0 text-muted" aria-hidden />
              {schoolName}
            </p>
            <p className={`mt-4 ${labelClass}`}>{t("Office phone", "कार्यालय फ़ोन")}</p>
            {ctx.school.phone ? (
              <a
                href={`tel:${ctx.school.phone.replace(/[^\d+]/g, "")}`}
                className="mt-1 inline-flex min-h-11 items-center gap-2 font-semibold text-forest-800 underline underline-offset-4"
              >
                <Phone className="h-4 w-4" aria-hidden />
                <span className="tabular">{ctx.school.phone}</span>
              </a>
            ) : (
              <p className="mt-1">{none}</p>
            )}
          </Card>

          {smsSettings.enabled && smsInfo ? (
            <Card>
              <CardTitle>{t("Text messages", "एसएमएस संदेश")}</CardTitle>
              <p className="flex items-start gap-2 text-forest-900">
                <Smartphone className="mt-1 h-4 w-4 shrink-0 text-muted" aria-hidden />
                <span>
                  {smsInfo.smsOff ? (
                    t("You asked not to get text messages from the school. To get them again, please tell the school office.", "आपने विद्यालय से एसएमएस संदेश न भेजने को कहा है। फिर से पाने के लिए कृपया विद्यालय कार्यालय को बताएँ।")
                  ) : smsNumbers.length ? (
                    <>
                      {t("Text messages from school go to ", "विद्यालय के एसएमएस संदेश ")}
                      {masked(smsNumbers[0])}
                      {smsNumbers[1] ? (
                        <>
                          {t(" and ", " और ")}
                          {masked(smsNumbers[1])}
                        </>
                      ) : null}
                      {t(". To stop them or change the number, please tell the school office.", " पर आते हैं। इन्हें बंद करवाने या नंबर बदलवाने के लिए कृपया विद्यालय कार्यालय को बताएँ।")}
                    </>
                  ) : (
                    t(
                      "The school has no mobile number for text messages. To get them, please tell the school office your mobile number.",
                      "विद्यालय के पास एसएमएस संदेशों के लिए आपका मोबाइल नंबर नहीं है। संदेश पाने के लिए कृपया विद्यालय कार्यालय को अपना मोबाइल नंबर बताएँ।",
                    )
                  )}
                </span>
              </p>
            </Card>
          ) : null}

          <Card>
            <CardTitle>{t("Sign-in", "साइन इन")}</CardTitle>
            <p className="text-forest-900">
              {t("Your login ID:", "आपकी लॉगिन आईडी:")} <strong className="font-semibold tabular">{ctx.actor.loginId}</strong>
            </p>
            <p className="mt-1 text-[0.92rem] text-muted">{t("Keep your password private, and change it if someone else may know it.", "अपना पासवर्ड किसी को न बताएँ। अगर किसी और को पता हो सकता है, तो उसे बदल दें।")}</p>
            <ButtonLink href="/account" variant="secondary" className="mt-4">
              <KeyRound className="h-4 w-4" aria-hidden />
              {t("Change password", "पासवर्ड बदलें")}
            </ButtonLink>
          </Card>
        </div>
      </div>
    </>
  );
}
