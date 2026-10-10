"use server";

import { refresh } from "next/cache";
import { getDb } from "@/lib/db/client";
import { auditActor } from "@/lib/auth/dal";
import { officePage } from "@/lib/page";
import { done, fail, messageOf, type FormState } from "@/lib/forms";
import { str } from "@/lib/validation";
import { MAX_PAPER_MARKS } from "@/components/exams/rules";
import { RecordError, classesWithSubjects, examPapersByClass, getExam, publishResults, reopenResults, sectionMeta, setClassPapers } from "@/lib/services/exams";

const parseMax = (s: string): number | null | "invalid" => {
  if (!s) return null;
  if (!/^\d{1,3}$/.test(s)) return "invalid";
  const n = Number(s);
  return n >= 1 && n <= MAX_PAPER_MARKS ? n : "invalid";
};
const MAX_HELP = `Use a whole number from 1 to ${MAX_PAPER_MARKS}, or leave it empty.`;

/** Save one class's papers, or apply the same maximum to every subject taught in it. */
export async function savePapersAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await officePage();
  const exam = await getExam(ctx, str(formData, "exam"));
  if (!exam) return fail("That exam was not found. Reload the page and try again.");
  const cls = (await classesWithSubjects(ctx.schoolId)).find((c) => c.id === str(formData, "class"));
  if (!cls) return fail("That class was not found. Reload the page and try again.");
  const current = (await examPapersByClass(exam.id)).get(cls.id) ?? [];

  const maxBySubject: Record<string, number | null> = {};
  if (str(formData, "intent") === "same") {
    const same = parseMax(str(formData, "same"));
    if (same === null || same === "invalid") return fail("Type the maximum marks to use for every subject.", { same: `Use a whole number from 1 to ${MAX_PAPER_MARKS}.` });
    if (!cls.subjects.length) return fail(`No subjects are taught in ${cls.label} yet. Add them under Classes & subjects first.`);
    for (const s of cls.subjects) maxBySubject[s.subjectId] = same;
  } else {
    const known = new Set([...cls.subjects.map((s) => s.subjectId), ...current.map((p) => p.subjectId)]);
    const errors: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (!key.startsWith("max:")) continue;
      const subjectId = key.slice(4);
      if (!known.has(subjectId)) return fail("One of the subjects is not taught in this class. Reload the page and try again.");
      const max = parseMax(typeof value === "string" ? value.trim() : "");
      if (max === "invalid") errors[key] = MAX_HELP;
      else maxBySubject[subjectId] = max;
    }
    if (Object.keys(errors).length) return fail(`Nothing was saved. Please correct the ${Object.keys(errors).length === 1 ? "highlighted box" : "highlighted boxes"}.`, errors);
  }

  let changed = 0;
  try {
    const db = await getDb();
    const actor = await auditActor(ctx.actor);
    ({ changed } = await db.transaction((tx) => setClassPapers(tx, ctx, exam.id, cls.id, maxBySubject, actor)));
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  refresh();
  if (!changed) return done(`No changes for ${cls.label}.`);
  const examined = Object.entries(maxBySubject).filter(([, m]) => m !== null).length + current.filter((p) => !(p.subjectId in maxBySubject)).length;
  return done(`Saved ${cls.label}: ${examined} ${examined === 1 ? "subject is" : "subjects are"} examined in ${exam.name}.`);
}

async function sectionOfSchool(ctx: { schoolId: string; sessionId: string }, sectionId: string) {
  const sec = await sectionMeta(sectionId);
  return sec && sec.schoolId === ctx.schoolId && sec.sessionId === ctx.sessionId ? sec : null;
}

/**
 * Publish a section's results (locks marks; missing marks need an explicit
 * "publish anyway"), or reopen published results with a reason. One action
 * for both, so the section's form — and its message — stays on screen when
 * the status changes.
 */
export async function sectionResultsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await officePage();
  const exam = await getExam(ctx, str(formData, "exam"));
  const sec = await sectionOfSchool(ctx, str(formData, "section"));
  if (!exam || !sec) return fail("That exam or class was not found. Reload the page and try again.");
  const intent = str(formData, "intent");
  if (intent !== "publish" && intent !== "reopen") return fail("Something went wrong. Reload the page and try again.");
  const reason = str(formData, "reason");
  if (intent === "reopen" && reason.length < 5) {
    return fail("Please write why the results are being reopened (at least 5 characters). It is kept in the activity log.");
  }
  let missing = 0;
  let texts = "";
  try {
    const db = await getDb();
    const actor = await auditActor(ctx.actor);
    if (intent === "publish") {
      const r = await db.transaction((tx) => publishResults(tx, ctx, exam.id, sec.id, { allowIncomplete: formData.get("allowIncomplete") === "on" }, actor));
      missing = r.missing;
      if (r.sms.queued) texts = ` ${r.sms.queued} ${r.sms.queued === 1 ? "family" : "families"} will get a text message saying the results are on the portal.`;
      if (r.sms.unreachable) texts += ` ${r.sms.unreachable} ${r.sms.unreachable === 1 ? "family doesn’t" : "families don’t"} get text messages (no mobile number, or they asked not to).`;
    } else {
      await db.transaction((tx) => reopenResults(tx, ctx, exam.id, sec.id, reason, actor));
    }
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  refresh();
  if (intent === "reopen") {
    return done(`Reopened ${exam.name} results for ${sec.label}. Families no longer see them and teachers can correct marks. Publish again when ready.`);
  }
  return done(
    `Published ${exam.name} results for ${sec.label}. Families can see them now, and marks are locked.${missing ? ` ${missing} missing ${missing === 1 ? "mark shows" : "marks show"} as “Not entered”.` : ""}${texts}`,
  );
}
