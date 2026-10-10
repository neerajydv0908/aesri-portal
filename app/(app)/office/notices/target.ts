/** Which audience the office's notice form shows: from ?to= (school, staff or a section id), else the notice's own. */
import "server-only";
import { listSections, sectionStudents, type SectionRow } from "@/lib/queries/school";
import type { NoticeRow } from "@/lib/services/notices";
import type { OfficeNoticeTo } from "./notice-form";

export async function chooseNoticeTo(
  ctx: { schoolId: string; sessionId: string },
  requested: string | undefined,
  notice?: Pick<NoticeRow, "audience" | "sectionId">,
): Promise<{ to: OfficeNoticeTo; value: string; sections: SectionRow[]; roll: { id: string; name: string; rollNo: number | null }[] }> {
  const sections = await listSections(ctx.schoolId, ctx.sessionId);
  const own = notice ? (notice.audience === "school" || notice.audience === "staff" ? notice.audience : (notice.sectionId ?? "school")) : "school";
  const want = typeof requested === "string" && requested ? requested : own;
  let to: OfficeNoticeTo = want === "staff" ? "staff" : "school";
  const section = sections.find((s) => s.id === want);
  if (section) to = section;
  const roll = section ? (await sectionStudents(section.id)).map((s) => ({ id: s.id, name: s.name, rollNo: s.rollNo })) : [];
  return { to, value: section ? section.id : (to as string), sections, roll };
}
