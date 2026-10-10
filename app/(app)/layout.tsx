import Link from "next/link";
import { KeyRound, LogOut } from "lucide-react";
import { AesriEmblem } from "@/components/brand/emblems";
import { LanguageSwitch } from "@/components/shell/language-switch";
import { navFor } from "@/components/shell/nav";
import { MobileMenu, NavList } from "@/components/shell/nav-list";
import { NavCountsProvider } from "@/components/shell/nav-counts";
import { getDb } from "@/lib/db/client";
import { schools } from "@/lib/db/schema";
import { officeSchoolId, requireActor } from "@/lib/auth/dal";
import { OFFICE_ROLES, roleLabel } from "@/lib/roles";
import { waitingClaimCount } from "@/lib/services/cash-claims";
import { demoDataPresent } from "@/lib/queries/app";
import { switchSchool } from "@/lib/actions/school";
import { tr, type Lang } from "@/lib/i18n";
import { getLang } from "@/lib/i18n/server";
import { logoutAction } from "../(auth)/actions";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  // Families can use Hindi throughout; staff screens are in English for now.
  const lang: Lang = actor.role === "student" ? await getLang() : "en";
  const t = tr(lang);
  const db = await getDb();
  const allSchools = await db.select({ id: schools.id, name: schools.name, nameHi: schools.nameHi }).from(schools).orderBy(schools.id);
  const schoolId = actor.role === "super_admin" ? await officeSchoolId(actor) : actor.schoolId;
  // The principal, office admins and AESRI administrators approve cash payments families record: a red dot on Fees while any wait.
  const approves = !!schoolId && OFFICE_ROLES.includes(actor.role);
  const cashToApprove = approves && schoolId ? await waitingClaimCount(db, schoolId) : 0;
  const groups = navFor(actor.role, lang);
  const school = allSchools.find((s) => s.id === schoolId);
  const schoolName = school ? (lang === "hi" ? school.nameHi : school.name) : "AESRI";
  const demo = await demoDataPresent();

  const userCard = (
    <div className="rounded-2xl bg-cream-50/[0.07] p-3.5">
      <p className="truncate font-semibold text-cream-50">{actor.name}</p>
      <p className="truncate text-[0.8rem] text-sage-200">
        {roleLabel(actor.role, lang)} · <span className="tabular">{actor.loginId}</span>
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Link href="/account" className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-[0.82rem] font-semibold text-cream-100 ring-1 ring-cream-50/20 hover:bg-cream-50/10">
          <KeyRound className="h-3.5 w-3.5" aria-hidden />
          {t("Password", "पासवर्ड")}
        </Link>
        <form action={logoutAction}>
          <button type="submit" className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-[0.82rem] font-semibold text-cream-100 ring-1 ring-cream-50/20 hover:bg-cream-50/10">
            <LogOut className="h-3.5 w-3.5" aria-hidden />
            {t("Sign out", "साइन आउट")}
          </button>
        </form>
      </div>
    </div>
  );

  return (
    <NavCountsProvider initial={{ cashToApprove }} stamp={crypto.randomUUID()} live={approves}>
      <div lang={lang} className="min-h-dvh lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="jaali-light no-print sticky top-0 hidden h-dvh flex-col overflow-y-auto bg-forest-900 px-4 py-6 text-cream-50 lg:flex">
          <Link href="/home" className="mb-8 flex items-center gap-3 px-2">
            <AesriEmblem className="h-10 w-10 shrink-0 text-sage-200" title="" />
            <span className="min-w-0">
              <span className="block font-display text-[1.15rem] leading-tight">{t("Campus Portal", "कैंपस पोर्टल")}</span>
              <span className="block truncate text-[0.78rem] text-sage-300">{schoolName}</span>
            </span>
          </Link>
          <NavList groups={groups} label={t("Main", "मुख्य मेनू")} />
          <div className="mt-auto pt-8">{userCard}</div>
        </aside>

        <div className="min-w-0">
          <header className="no-print sticky top-0 z-30 flex min-h-16 items-center gap-3 border-b border-forest-900/10 bg-cream-100/90 px-3 backdrop-blur sm:px-6 lg:px-10">
            <MobileMenu groups={groups} label={t("Menu", "मेनू")} closeLabel={t("Close menu", "मेनू बंद करें")} navLabel={t("Main", "मुख्य मेनू")}>
              {userCard}
            </MobileMenu>
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <AesriEmblem className="h-8 w-8 shrink-0 text-forest-700 lg:hidden" title="" />
              <p className="truncate font-semibold text-forest-900">{schoolName}</p>
            </div>
            {actor.role === "super_admin" ? (
              <form action={switchSchool} className="flex items-center gap-2">
                <label htmlFor="school-switch" className="sr-only">
                  Working in school
                </label>
                <select
                  id="school-switch"
                  name="school"
                  defaultValue={schoolId ?? undefined}
                  className="min-h-10 rounded-full bg-cream-50 px-3 text-[0.88rem] font-semibold ring-1 ring-forest-900/15"
                >
                  {allSchools.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <button type="submit" className="min-h-10 rounded-full bg-forest-800 px-3.5 text-[0.85rem] font-semibold text-cream-50 hover:bg-forest-700">
                  Switch
                </button>
              </form>
            ) : null}
            {actor.role === "student" ? <LanguageSwitch lang={lang} /> : null}
          </header>
          {demo ? (
            <p className="no-print border-b border-ochre-500/30 bg-ochre-50 px-4 py-2 text-center text-[0.85rem] font-semibold text-ochre-600 sm:px-6">
              {t("Demo data: every person shown here is fictional.", "डेमो डेटा: यहाँ दिखाए गए सभी व्यक्ति काल्पनिक हैं।")}
            </p>
          ) : null}
          <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 py-8 outline-none sm:px-6 lg:px-10 lg:py-10 print:max-w-none print:p-0">
            {children}
          </main>
          <footer className="no-print mx-auto w-full max-w-6xl px-4 pb-8 text-[0.82rem] text-muted sm:px-6 lg:px-10">
            <Link href="/privacy" className="inline-block min-h-6 font-semibold text-forest-800 underline-offset-2 hover:underline">
              {t("Privacy notice", "गोपनीयता सूचना")}
            </Link>
          </footer>
        </div>
      </div>
    </NavCountsProvider>
  );
}
