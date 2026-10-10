/**
 * The boxes of a notice: category, English title and text, an optional Hindi
 * version, and the days it shows. Used by the office and by class teachers.
 * Errors come from the Server Action through <ActionForm> / <FieldError>.
 */
import { Field, Input, Select, Textarea } from "@/components/ui";
import { FieldError } from "@/components/forms";
import { NOTICE_CATEGORIES, NOTICE_LIMITS, type NoticeContent } from "@/lib/services/notices";
import { translationOn } from "@/lib/translate";

export function NoticeFields({
  defaults,
  withPublishOn,
  minDate,
  maxDate,
}: {
  defaults?: Partial<NoticeContent>;
  /** Office notices choose the first day to show; class notices show from today. */
  withPublishOn: boolean;
  minDate?: string;
  maxDate?: string;
}) {
  return (
    <>
      <Field label="Category" htmlFor="category" required>
        <Select id="category" name="category" required defaultValue={defaults?.category ?? "general"} aria-describedby="category-error" className="sm:max-w-xs">
          {NOTICE_CATEGORIES.map((c) => (
            <option key={c.key} value={c.key}>
              {c.en}
            </option>
          ))}
        </Select>
        <FieldError name="category" />
      </Field>

      <Field label="Title" htmlFor="titleEn" required hint="Short and clear, for example “Dussehra holidays: 19 to 21 October”.">
        <Input
          id="titleEn"
          name="titleEn"
          required
          maxLength={NOTICE_LIMITS.title}
          defaultValue={defaults?.titleEn ?? ""}
          aria-describedby="titleEn-hint titleEn-error"
        />
        <FieldError name="titleEn" />
      </Field>
      <Field label="Notice" htmlFor="bodyEn" required hint="Say what is happening, when, and what readers need to do.">
        <Textarea
          id="bodyEn"
          name="bodyEn"
          rows={6}
          required
          maxLength={NOTICE_LIMITS.body}
          defaultValue={defaults?.bodyEn ?? ""}
          aria-describedby="bodyEn-hint bodyEn-error"
        />
        <FieldError name="bodyEn" />
      </Field>

      <fieldset className="grid gap-4 rounded-2xl bg-cream-100/70 p-4 ring-1 ring-forest-900/10 sm:p-5">
        <legend className="px-1 text-[0.92rem] font-semibold text-forest-900">Hindi version (recommended)</legend>
        <p className="-mt-1 text-[0.88rem] text-muted">
          Many families read Hindi. Families who choose <span lang="hi">हिंदी</span> see this version;{" "}
          {translationOn() ? "if it’s empty they see an automatic Hindi translation of the English one." : "if it’s empty they see the English one."} Staff see the English one.
        </p>
        <Field label="Title in Hindi" htmlFor="titleHi">
          <Input
            id="titleHi"
            name="titleHi"
            lang="hi"
            maxLength={NOTICE_LIMITS.title}
            defaultValue={defaults?.titleHi ?? ""}
            aria-describedby="titleHi-error"
          />
          <FieldError name="titleHi" />
        </Field>
        <Field label="Notice in Hindi" htmlFor="bodyHi">
          <Textarea
            id="bodyHi"
            name="bodyHi"
            lang="hi"
            rows={5}
            maxLength={NOTICE_LIMITS.body}
            defaultValue={defaults?.bodyHi ?? ""}
            aria-describedby="bodyHi-error"
          />
          <FieldError name="bodyHi" />
        </Field>
      </fieldset>

      <div className={withPublishOn ? "grid gap-5 sm:grid-cols-2" : "grid gap-5 sm:max-w-xs"}>
        {withPublishOn ? (
          <Field label="Show from" htmlFor="publishOn" required hint="Published notices appear on this day.">
            <Input
              id="publishOn"
              name="publishOn"
              type="date"
              required
              min={minDate}
              max={maxDate}
              defaultValue={defaults?.publishOn ?? ""}
              aria-describedby="publishOn-hint publishOn-error"
            />
            <FieldError name="publishOn" />
          </Field>
        ) : null}
        <Field label="Last day to show (optional)" htmlFor="expiresOn" hint="Leave empty to keep it up until it is archived.">
          <Input
            id="expiresOn"
            name="expiresOn"
            type="date"
            min={minDate}
            max={maxDate}
            defaultValue={defaults?.expiresOn ?? ""}
            aria-describedby="expiresOn-hint expiresOn-error"
          />
          <FieldError name="expiresOn" />
        </Field>
      </div>
    </>
  );
}
