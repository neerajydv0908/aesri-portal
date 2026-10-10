/** The boxes shared by "Record a remark" and "Edit remark". */
import clsx from "clsx";
import type { ReactNode } from "react";
import { HindiForFamilies } from "@/components/translate/staff-hint";
import { Flag, Star } from "lucide-react";
import { Checkbox, Field, Select, Textarea } from "@/components/ui";
import { FieldError } from "@/components/forms";
import { REMARK_CATEGORIES, REMARK_LIMITS, type RemarkFields as Values } from "@/lib/services/remarks";

function KindOption({
  value,
  label,
  hint,
  icon,
  checked,
  tone,
}: {
  value: string;
  label: string;
  hint: string;
  icon: ReactNode;
  checked: boolean;
  tone: "green" | "amber";
}) {
  return (
    <label
      className={clsx(
        "flex min-h-14 cursor-pointer items-center gap-3 rounded-2xl bg-cream-50 px-3.5 py-2.5 ring-1 ring-forest-900/15 transition-colors hover:ring-forest-900/35",
        "has-checked:ring-2 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ochre-500",
        tone === "green" ? "has-checked:bg-sage-50 has-checked:ring-forest-700" : "has-checked:bg-ochre-50 has-checked:ring-ochre-600",
      )}
    >
      <input
        type="radio"
        name="kind"
        value={value}
        defaultChecked={checked}
        required
        className="h-5 w-5 shrink-0 accent-forest-700"
        aria-describedby="kind-error"
      />
      <span className="min-w-0">
        <span className={clsx("flex items-center gap-1.5 font-semibold", tone === "green" ? "text-forest-800" : "text-ochre-600")}>
          {icon}
          {label}
        </span>
        <span className="block text-[0.82rem] leading-snug text-muted">{hint}</span>
      </span>
    </label>
  );
}

export function RemarkFields({ defaults, smsNote }: { defaults?: Partial<Values>; /** What happens by text message when the remark is shown to the family. */ smsNote?: string | null }) {
  return (
    <>
      <fieldset className="grid gap-2">
        <legend className="mb-1.5 text-[0.92rem] font-semibold text-forest-900">
          Kind of remark<span className="text-clay-600"> *</span>
        </legend>
        <div className="@container">
          <div className="grid gap-2 @min-[20rem]:grid-cols-2">
            <KindOption
              value="appreciation"
              label="Appreciation"
              hint="Something done well"
              icon={<Star className="h-4 w-4" aria-hidden />}
              checked={defaults?.kind === "appreciation"}
              tone="green"
            />
            <KindOption
              value="concern"
              label="Concern"
              hint="A complaint or worry"
              icon={<Flag className="h-4 w-4" aria-hidden />}
              checked={defaults?.kind === "concern"}
              tone="amber"
            />
          </div>
        </div>
        <FieldError name="kind" />
      </fieldset>
      <Field label="What is it about?" htmlFor="category" required>
        <Select id="category" name="category" required defaultValue={defaults?.category ?? ""} aria-describedby="category-error">
          <option value="" disabled>
            Choose…
          </option>
          {REMARK_CATEGORIES.map((c) => (
            <option key={c.key} value={c.key}>
              {c.en}
            </option>
          ))}
        </Select>
        <FieldError name="category" />
      </Field>
      <Field label="Remark" htmlFor="note" required hint="What happened, in a sentence or two. Write it as you would to the family.">
        <Textarea
          id="note"
          name="note"
          rows={3}
          required
          maxLength={REMARK_LIMITS.note}
          defaultValue={defaults?.note ?? ""}
          className="min-h-24"
          aria-describedby="note-hint note-error"
        />
        <FieldError name="note" />
        <HindiForFamilies what="a shared remark (and the action taken)" />
      </Field>
      <Field label="Action taken (optional)" htmlFor="actionTaken" hint="For example: spoke to the student, phoned the parent, extra practice.">
        <Textarea
          id="actionTaken"
          name="actionTaken"
          rows={2}
          maxLength={REMARK_LIMITS.actionTaken}
          defaultValue={defaults?.actionTaken ?? ""}
          className="min-h-20"
          aria-describedby="actionTaken-hint"
        />
      </Field>
      <Checkbox
        name="visibleToGuardian"
        value="yes"
        defaultChecked={defaults?.visibleToGuardian ?? true}
        label={
          <>
            <span className="font-semibold">Show to the family</span>
            <span className="block text-[0.85rem] text-muted">
              They see it on their Teacher remarks page. Untick it for a staff-only note: then only the class teacher, the school office and the person who wrote it
              can read it.
            </span>
            {smsNote ? <span className="mt-1 block text-[0.85rem] text-forest-900/85">{smsNote}</span> : null}
          </>
        }
      />
    </>
  );
}
