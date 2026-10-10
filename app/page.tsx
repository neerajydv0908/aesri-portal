import { redirect } from "next/navigation";
import { getActor } from "@/lib/auth/dal";

export default async function Index() {
  const actor = await getActor();
  redirect(actor ? "/home" : "/login");
}
