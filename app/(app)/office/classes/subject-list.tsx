/** The school's list of subjects: add, rename, and remove one nothing uses. */
import { BookOpen, Pencil, Plus } from "lucide-react";
import { ActionForm, FieldError } from "@/components/forms";
import { Card, CardTitle, EmptyState, Field, Input, Table, Td, Th } from "@/components/ui";
import { ConfirmSubmit, SubmitButton } from "@/components/ui/client";
import { SUBJECT_LIMITS, subjectUsageReasons, type SubjectRow } from "@/lib/services/classes";
import { addSubjectAction, removeSubjectAction, renameSubjectAction } from "./actions";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function usageText(r: SubjectRow): string {
  const u = r.usage;
  const parts = [u.classes ? plural(u.classes, "class", "classes") : null, u.staff ? plural(u.staff, "teacher lists it", "teachers list it") : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Not used yet";
}

export function SubjectListView({ subjects }: { subjects: SubjectRow[] }) {
  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section aria-labelledby="subject-list">
        <h2 id="subject-list" className="mb-1 font-display text-[1.35rem] text-forest-900">
          The school&rsquo;s subjects
        </h2>
        <p className="mb-4 text-[0.95rem] text-muted">
          Families see the Hindi name when they read the portal in Hindi. The Excel import matches the English or Hindi name in “Subjects taught”, understands
          short forms such as Maths, EVS or SST, and adds a subject that isn&rsquo;t in this list yet.
        </p>
        {subjects.length ? (
          <Table caption="The school's subjects">
            <thead>
              <tr>
                <Th>Subject</Th>
                <Th>Used in</Th>
                <Th>
                  <span className="sr-only">Change</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {subjects.map((s) => {
                const reasons = subjectUsageReasons(s.usage);
                return (
                  <tr key={s.id} className="align-top">
                    <Td className="min-w-48">
                      <span className="block font-semibold text-forest-900">{s.name}</span>
                      {s.nameHi ? (
                        <span lang="hi" className="block text-forest-900/80">
                          {s.nameHi}
                        </span>
                      ) : (
                        <span className="block text-[0.85rem] text-muted">No Hindi name</span>
                      )}
                    </Td>
                    <Td className="min-w-40 text-[0.92rem]">{usageText(s)}</Td>
                    <Td className="min-w-72">
                      <details className="group">
                        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full px-1 text-[0.92rem] font-semibold text-forest-800 hover:text-forest-600 [&::-webkit-details-marker]:hidden">
                          <Pencil className="h-4 w-4" aria-hidden />
                          Rename or remove<span className="sr-only"> {s.name}</span>
                        </summary>
                        <div className="mt-3 grid gap-4">
                          <ActionForm action={renameSubjectAction} className="gap-3">
                            <input type="hidden" name="subject" value={s.id} />
                            <Field label="English name" htmlFor={`name-${s.id}`}>
                              <Input id={`name-${s.id}`} name="name" defaultValue={s.name} maxLength={SUBJECT_LIMITS.name} required autoComplete="off" />
                            </Field>
                            <Field label="Hindi name" htmlFor={`hi-${s.id}`}>
                              <Input id={`hi-${s.id}`} name="nameHi" lang="hi" defaultValue={s.nameHi ?? ""} maxLength={SUBJECT_LIMITS.name} autoComplete="off" />
                            </Field>
                            <div>
                              <SubmitButton variant="secondary" pendingLabel="Saving…">
                                Save<span className="sr-only"> {s.name}</span>
                              </SubmitButton>
                            </div>
                          </ActionForm>
                          {reasons.length ? (
                            <p className="text-[0.85rem] text-muted">
                              <span className="font-semibold">Can&rsquo;t be removed:</span> {reasons.join("; ")}.
                            </p>
                          ) : (
                            <ActionForm action={removeSubjectAction} className="gap-2">
                              <input type="hidden" name="subject" value={s.id} />
                              <div>
                                <ConfirmSubmit question={`Remove ${s.name}?`} confirmLabel="Yes, remove">
                                  Remove<span className="sr-only"> {s.name}</span>
                                </ConfirmSubmit>
                              </div>
                            </ActionForm>
                          )}
                        </div>
                      </details>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <EmptyState icon={<BookOpen className="h-5 w-5" aria-hidden />} title="No subjects yet">
            Add the subjects taught at the school, then tick them for each class on the Classes tab.
          </EmptyState>
        )}
      </section>

      <Card className="lg:sticky lg:top-24">
        <CardTitle>Add a subject</CardTitle>
        <ActionForm action={addSubjectAction} resetOnSuccess className="gap-4">
          <Field label="English name" htmlFor="new-name" hint="For example Science, or Art & Drawing." required>
            <Input id="new-name" name="name" maxLength={SUBJECT_LIMITS.name} required autoComplete="off" aria-describedby="new-name-hint name-error" />
            <FieldError name="name" />
          </Field>
          <Field label="Hindi name" htmlFor="new-hi" hint="Optional, for example विज्ञान.">
            <Input id="new-hi" name="nameHi" lang="hi" maxLength={SUBJECT_LIMITS.name} autoComplete="off" aria-describedby="new-hi-hint nameHi-error" />
            <FieldError name="nameHi" />
          </Field>
          <div>
            <SubmitButton pendingLabel="Adding…">
              <Plus className="h-4 w-4" aria-hidden />
              Add subject
            </SubmitButton>
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}
