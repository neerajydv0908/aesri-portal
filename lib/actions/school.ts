"use server";

import { cookies } from "next/headers";
import { requireActor, SCHOOL_COOKIE } from "@/lib/auth/dal";

/** AESRI administrators choose which school's office pages they are working in. */
export async function switchSchool(formData: FormData): Promise<void> {
  await requireActor(["super_admin"]);
  const school = String(formData.get("school") ?? "");
  if (!["aryavart", "aadharshila"].includes(school)) return;
  (await cookies()).set(SCHOOL_COOKIE, school, { path: "/", sameSite: "lax", httpOnly: true, maxAge: 60 * 60 * 24 * 30 });
}
