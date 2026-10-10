import type { Metadata } from "next";
import { getActor, requireActor } from "@/lib/auth/dal";
import { getLang } from "@/lib/i18n/server";
import { AccountsHome } from "./accounts";
import { FamilyHome } from "./family";
import { OfficeHome } from "./office";
import { TeacherHome } from "./teacher";

export async function generateMetadata(): Promise<Metadata> {
  const actor = await getActor();
  return { title: actor?.role === "student" && (await getLang()) === "hi" ? "मुख्य पृष्ठ" : "Home" };
}

type SP = { welcome?: string; secured?: string };

/** The first page after signing in: what matters today, for each kind of account. */
export default async function HomePage({ searchParams }: { searchParams: Promise<SP> }) {
  const actor = await requireActor();
  const sp = await searchParams;
  // After first activation (families, teachers) or after setting up the authenticator (admin-type accounts).
  const welcome = sp.welcome === "1" || sp.secured === "1";
  switch (actor.role) {
    case "student":
      return <FamilyHome welcome={welcome} />;
    case "teacher":
      return <TeacherHome welcome={welcome} />;
    case "accounts":
      return <AccountsHome welcome={welcome} />;
    default:
      return <OfficeHome welcome={welcome} />;
  }
}
