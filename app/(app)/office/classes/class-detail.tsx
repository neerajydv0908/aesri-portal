/** One class: its sections and class teachers, its subjects, and who teaches each subject in each section. */
import Link from "next/link";
import { Plus } from "lucide-react";
import { ActionForm } from "@/components/forms";
import { Alert, Card, CardTitle, Checkbox, Select } from "@/components/ui";
import { ConfirmSubmit, SubmitButton } from "@/components/ui/client";
import { SECTION_LETTERS, sectionUsageReasons, type ClassDetail, type StaffOption } from "@/lib/services/classes";
import { addSectionAction, removeSectionAction, saveClassSubjectsAction, saveSectionTeachersAction, setClassTeacherAction } from "./actions";

const ACCESS_NOTE: Record<string, string> = { accounts: "accounts only", none: "no login" };

/** How a person appears in a list: their name, with the employee No. when two people share a name. */
function staffLabel(s: StaffOption, all: StaffOption[]) {
  const twin = all.some((o) => o.id !== s.id && o.name === s.name);
  const note = s.status === "left" ? "has left" : !s.canTeach ? ACCESS_NOTE[s.access] : null;
  return `${s.name}${twin ? ` (Emp. ${s.empNo})` : ""}${note ? ` — ${note}` : ""}`;
}

export function ClassDetailView({ detail }: { detail: ClassDetail }) {
  const { cls, sections, staff, taught } = detail;
  const teachers = staff.filter((s) => s.canTeach);
  const nextLetter = SECTION_LETTERS.find((l) => !sections.some((s) => s.name === l));
  return (
    <div className="grid grid-cols-1 gap-6">
      <h2 className="font-display text-[1.7rem] text-forest-900">{cls.label}</h2>

      {/* Sections and class teachers */}
      <Card>
        <CardTitle>Sections and class teachers</CardTitle>
        {!teachers.length ? (
          <Alert tone="amber" className="mb-4">
            No member of staff can be a class teacher yet: class teachers need Teacher, Principal or Office admin access. Add staff on the Staff page or with Import from Excel.
          </Alert>
        ) : null}
        <ul className="divide-y divide-forest-900/10 rounded-2xl ring-1 ring-forest-900/10">
          {sections.map((s) => {
            const reasons = sectionUsageReasons(s.usage);
            const current = s.classTeacherId ? staff.find((x) => x.id === s.classTeacherId) : undefined;
            const options = current && !current.canTeach ? [current, ...teachers] : teachers;
            return (
              <li key={s.id} className="grid gap-3 p-4 md:grid-cols-[8rem_minmax(0,1fr)_minmax(0,15rem)] md:items-start md:gap-5">
                <div>
                  <h3 className="font-sans text-[1.05rem] font-bold tracking-normal text-forest-900">{s.label}</h3>
                  <p className="text-[0.88rem] text-muted tabular">
                    {s.students} {s.students === 1 ? "student" : "students"}
                  </p>
                </div>
                <ActionForm action={setClassTeacherAction} className="gap-1.5" messagePosition="bottom">
                  <input type="hidden" name="section" value={s.id} />
                  <label htmlFor={`ct-${s.id}`} className="text-[0.85rem] font-semibold text-forest-900">
                    Class teacher<span className="sr-only"> of {s.label}</span>
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Select id={`ct-${s.id}`} name="staff" defaultValue={s.classTeacherId ?? ""} className="min-w-0 flex-1 basis-56">
                      <option value="">— No class teacher —</option>
                      {options.map((o) => (
                        <option key={o.id} value={o.id}>
                          {staffLabel(o, staff)}
                        </option>
                      ))}
                    </Select>
                    <SubmitButton variant="secondary" pendingLabel="Saving…">
                      Save<span className="sr-only"> class teacher of {s.label}</span>
                    </SubmitButton>
                  </div>
                </ActionForm>
                <div className="md:pt-6">
                  {reasons.length ? (
                    <p className="text-[0.85rem] text-muted">
                      <span className="font-semibold">Can&rsquo;t be removed:</span> {reasons.join("; ")}.
                    </p>
                  ) : sections.length > 1 ? (
                    <ActionForm action={removeSectionAction} className="gap-2" messagePosition="bottom">
                      <input type="hidden" name="section" value={s.id} />
                      <input type="hidden" name="class" value={cls.id} />
                      <div>
                        <ConfirmSubmit question={`Remove ${s.label}?`} confirmLabel="Yes, remove">
                          Remove<span className="sr-only"> {s.label}</span>
                        </ConfirmSubmit>
                      </div>
                    </ActionForm>
                  ) : (
                    <p className="text-[0.85rem] text-muted">The only section of this class.</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="mt-5 border-t border-forest-900/10 pt-4">
          {nextLetter ? (
            <ActionForm action={addSectionAction} className="gap-2">
              <input type="hidden" name="class" value={cls.id} />
              <div>
                <SubmitButton variant="secondary" pendingLabel="Adding…">
                  <Plus className="h-4 w-4" aria-hidden />
                  Add section {cls.name}-{nextLetter}
                </SubmitButton>
              </div>
              <p className="text-[0.88rem] text-muted">A section can be removed again while nothing uses it (no students, attendance, homework, results or notices).</p>
            </ActionForm>
          ) : (
            <p className="text-[0.92rem] text-muted">{cls.label} has six sections (A to F), the most the portal allows.</p>
          )}
        </div>
      </Card>

      {/* Subjects taught in the class */}
      <Card>
        <CardTitle>Subjects taught in {cls.label}</CardTitle>
        {detail.allSubjects.length ? (
          <ActionForm action={saveClassSubjectsAction}>
            <input type="hidden" name="class" value={cls.id} />
            <fieldset>
              <legend className="mb-3 text-[0.95rem] text-forest-900">Tick every subject this class is taught.</legend>
              <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                {detail.allSubjects.map((sub) => {
                  const papers = detail.papersBySubject.get(sub.id);
                  return (
                    <Checkbox
                      key={sub.id}
                      name="subject"
                      value={sub.id}
                      defaultChecked={taught.some((t) => t.id === sub.id)}
                      label={
                        <>
                          <span className="font-semibold">{sub.name}</span>
                          {sub.nameHi ? (
                            <span lang="hi" className="text-muted">
                              {" "}
                              · {sub.nameHi}
                            </span>
                          ) : null}
                          {papers ? <span className="block text-[0.82rem] text-muted">Has exam papers ({papers.join(", ")})</span> : null}
                        </>
                      }
                    />
                  );
                })}
              </div>
            </fieldset>
            <p className="text-[0.88rem] text-muted">
              Unticking a subject also removes who teaches it in this class&rsquo;s sections. A subject with exam papers this session stays until the paper is removed on
              the Exams page. Missing a subject?{" "}
              <Link href="/office/classes?view=subjects" className="font-semibold text-forest-800 underline underline-offset-2">
                Add it to the school&rsquo;s subjects
              </Link>
              .
            </p>
            <div>
              <SubmitButton pendingLabel="Saving…">Save subjects</SubmitButton>
            </div>
          </ActionForm>
        ) : (
          <p className="text-forest-900">
            The school has no subjects yet.{" "}
            <Link href="/office/classes?view=subjects" className="font-semibold text-forest-800 underline underline-offset-2">
              Add the school&rsquo;s subjects
            </Link>{" "}
            first, then tick the ones this class is taught.
          </p>
        )}
      </Card>

      {/* Who teaches what */}
      <Card>
        <CardTitle>Who teaches what</CardTitle>
        {!taught.length ? (
          <p className="text-forest-900">Tick the subjects {cls.label} is taught first; then choose a teacher for each one here.</p>
        ) : (
          <div className="grid grid-cols-1 gap-8">
            <p className="-mt-2 text-[0.92rem] text-muted">
              For each section, choose who teaches each subject. They can then enter its marks and set homework. People who list the subject among the subjects they
              teach come first.
            </p>
            {sections.map((sec) => (
              <section key={sec.id} aria-labelledby={`teach-${sec.id}`} className="rounded-2xl p-4 ring-1 ring-forest-900/10">
                <h3 id={`teach-${sec.id}`} className="mb-3 font-sans text-[1.05rem] font-bold tracking-normal text-forest-900">
                  {sec.label}
                </h3>
                <ActionForm action={saveSectionTeachersAction} className="gap-4">
                  <input type="hidden" name="section" value={sec.id} />
                  <div className="grid gap-3">
                    {taught.map((sub) => {
                      const assigned = detail.assignments.find((a) => a.sectionId === sec.id && a.subjectId === sub.id)?.staffId ?? "";
                      const current = assigned ? staff.find((x) => x.id === assigned) : undefined;
                      const specialists = teachers.filter((t) => t.subjectIds.includes(sub.id));
                      const others = teachers.filter((t) => !t.subjectIds.includes(sub.id));
                      const id = `t-${sec.id}-${sub.id}`;
                      return (
                        <div key={sub.id} className="grid gap-1.5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:items-center sm:gap-4">
                          <label htmlFor={id} className="font-semibold text-forest-900">
                            {sub.name}
                            <span className="sr-only"> in {sec.label}</span>
                          </label>
                          <Select id={id} name={`teacher:${sub.id}`} defaultValue={assigned}>
                            <option value="">— Not assigned —</option>
                            {current && !current.canTeach ? (
                              <optgroup label="Assigned now">
                                <option value={current.id}>{staffLabel(current, staff)}</option>
                              </optgroup>
                            ) : null}
                            {specialists.length ? (
                              <optgroup label={`Teaches ${sub.name}`}>
                                {specialists.map((t) => (
                                  <option key={t.id} value={t.id}>
                                    {staffLabel(t, staff)}
                                  </option>
                                ))}
                              </optgroup>
                            ) : null}
                            {others.length ? (
                              <optgroup label={specialists.length ? "Other staff" : "All staff"}>
                                {others.map((t) => (
                                  <option key={t.id} value={t.id}>
                                    {staffLabel(t, staff)}
                                  </option>
                                ))}
                              </optgroup>
                            ) : null}
                          </Select>
                        </div>
                      );
                    })}
                  </div>
                  <div>
                    <SubmitButton pendingLabel="Saving…">Save teachers for {sec.label}</SubmitButton>
                  </div>
                </ActionForm>
              </section>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
