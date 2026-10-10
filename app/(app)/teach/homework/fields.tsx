/** The title, details and date boxes shared by "Set homework" and "Edit homework". */
import { Field, Input, Textarea } from "@/components/ui";
import { FieldError } from "@/components/forms";
import { HOMEWORK_LIMITS } from "@/lib/services/homework";
import { HindiForFamilies } from "@/components/translate/staff-hint";

export function HomeworkFields({
  defaults,
  min,
  max,
}: {
  defaults: { title?: string; details?: string | null; assignedOn: string; dueOn: string };
  min: string;
  max: string;
}) {
  return (
    <>
      <Field label="Title" htmlFor="title" required hint="What to do, in a few words — for example “Exercise 4.2, questions 1–10”.">
        <Input
          id="title"
          name="title"
          required
          maxLength={HOMEWORK_LIMITS.title}
          defaultValue={defaults.title ?? ""}
          aria-describedby="title-hint title-error"
        />
        <FieldError name="title" />
      </Field>
      <Field label="Details (optional)" htmlFor="details" hint="Page numbers, what to bring, or how it will be checked.">
        <Textarea
          id="details"
          name="details"
          rows={4}
          maxLength={HOMEWORK_LIMITS.details}
          defaultValue={defaults.details ?? ""}
          aria-describedby="details-hint"
        />
      </Field>
      <HindiForFamilies what="the title and details" />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Set on" htmlFor="assignedOn" required>
          <Input
            id="assignedOn"
            name="assignedOn"
            type="date"
            required
            min={min}
            max={max}
            defaultValue={defaults.assignedOn}
            aria-describedby="assignedOn-error"
          />
          <FieldError name="assignedOn" />
        </Field>
        <Field label="Due on" htmlFor="dueOn" required hint="The same day or later.">
          <Input id="dueOn" name="dueOn" type="date" required min={min} max={max} defaultValue={defaults.dueOn} aria-describedby="dueOn-hint dueOn-error" />
          <FieldError name="dueOn" />
        </Field>
      </div>
    </>
  );
}
