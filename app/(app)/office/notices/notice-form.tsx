/** The office's notice form, for a new notice or an existing draft or published notice. */
import { ButtonLink } from "@/components/ui";
import { SubmitButton } from "@/components/ui/client";
import { ActionForm, FieldError } from "@/components/forms";
import { NoticeFields } from "@/components/daily/notice-fields";
import { ClassAudienceFields } from "@/components/sms/notice-audience";
import { SmsHint } from "@/components/sms/parts";
import { officeNoticeSmsText, type OfficeNoticeTo } from "@/components/sms/texts";
import type { NoticeSmsInfo } from "@/lib/queries/sms";
import { isNoticeCategory, type NoticeRow } from "@/lib/services/notices";
import { saveOfficeNoticeAction } from "./actions";

export type { OfficeNoticeTo };

function audienceWords(to: OfficeNoticeTo) {
  if (to === "school") return { title: "Whole school", hint: "Every family, and all staff who sign in." };
  if (to === "staff") return { title: "Staff only", hint: "All staff who sign in (teachers, office and accounts), not families." };
  return { title: `Class ${to.label}${to.stream ? ` (${to.stream})` : ""}`, hint: `${to.longLabel}: the whole class, or chosen students of it.` };
}

export function OfficeNoticeForm({
  notice,
  to,
  roll,
  chosen,
  today,
  minDate,
  maxDate,
  sms,
}: {
  notice?: NoticeRow;
  to: OfficeNoticeTo;
  /** The chosen class's students (for "Chosen students"). */
  roll: { id: string; name: string; rollNo: number | null }[];
  /** Students already chosen (editing a notice to chosen students). */
  chosen: string[];
  today: string;
  minDate: string;
  maxDate: string;
  sms: NoticeSmsInfo;
}) {
  const published = notice?.status === "published";
  const words = audienceWords(to);
  const section = typeof to === "object" ? to : null;
  return (
    <ActionForm action={saveOfficeNoticeAction}>
      {notice ? <input type="hidden" name="id" value={notice.id} /> : null}
      <input type="hidden" name="to" value={section ? section.id : (to as string)} />
      <div className="grid gap-1">
        <p className="text-[0.92rem] font-semibold text-forest-900">For</p>
        <p className="text-forest-900">
          <span className="font-semibold">{words.title}</span> <span className="text-muted">· {words.hint}</span>
        </p>
        <FieldError name="to" />
      </div>
      {section ? (
        <ClassAudienceFields
          sectionLabel={section.label}
          roll={roll}
          defaultScope={notice?.audience === "students" && notice.sectionId === section.id ? "students" : "section"}
          defaultChosen={chosen}
        />
      ) : null}
      <NoticeFields
        withPublishOn
        minDate={minDate}
        maxDate={maxDate}
        defaults={notice ? { ...notice, category: isNoticeCategory(notice.category) ? notice.category : "general" } : { publishOn: today, category: "general" }}
      />
      <SmsHint>{officeNoticeSmsText(to, sms, published)}</SmsHint>
      {published ? (
        <p className="rounded-2xl bg-ochre-50 px-4 py-3 text-[0.92rem] text-forest-900 ring-1 ring-ochre-500/30">
          This notice is already published. Saving changes makes it version {notice!.version + 1}; the earlier wording is kept in the activity log.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {published ? (
          <SubmitButton name="intent" value="save" pendingLabel="Saving…">
            Save changes
          </SubmitButton>
        ) : (
          <>
            {/* "Save as draft" comes first, so pressing Enter in a box never publishes by accident. */}
            <SubmitButton name="intent" value="draft" variant="secondary" pendingLabel="Saving…">
              Save as draft
            </SubmitButton>
            <SubmitButton name="intent" value="publish" pendingLabel="Publishing…">
              Publish
            </SubmitButton>
          </>
        )}
        <ButtonLink href={`/office/notices?status=${notice?.status === "draft" || notice?.status === "pending" ? "draft" : "published"}`} variant="ghost">
          Cancel
        </ButtonLink>
      </div>
    </ActionForm>
  );
}
