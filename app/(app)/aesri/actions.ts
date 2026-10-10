"use server";

import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { staff } from "@/lib/db/schema";
import { switchSchool } from "@/lib/actions/school";
import { requireActor } from "@/lib/auth/dal";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Work in this school": choose the school in the switcher, then go to Home. */
export async function workInSchoolAction(formData: FormData): Promise<void> {
  await requireActor(["super_admin"]);
  await switchSchool(formData);
  redirect("/home");
}

/** Open a staff record: office pages show the school chosen in the switcher, so choose the staff member's school first. */
export async function openStaffAction(formData: FormData): Promise<void> {
  await requireActor(["super_admin"]);
  const staffId = String(formData.get("staff") ?? "");
  if (!UUID.test(staffId)) notFound();
  const db = await getDb();
  const [s] = await db.select({ schoolId: staff.schoolId }).from(staff).where(eq(staff.id, staffId));
  if (!s) notFound();
  const choice = new FormData();
  choice.set("school", s.schoolId);
  await switchSchool(choice);
  redirect(`/office/staff/${staffId}`);
}
