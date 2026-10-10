/**
 * What staff are told on forms about the text messages a change will send
 * ("The families of IV-A also get a text message…"), from the school's
 * settings (lib/queries/sms.ts noticeSmsInfo).
 */
import type { NoticeSmsInfo } from "@/lib/queries/sms";
import type { SectionRow } from "@/lib/queries/school";

export type OfficeNoticeTo = "school" | "staff" | SectionRow;

/** For the office's notice form, by audience. */
export function officeNoticeSmsText(to: OfficeNoticeTo, info: NoticeSmsInfo, published: boolean): string {
  if (published) return "It is already published, so saving changes sends no new text message.";
  if (info.notSetUp) return "Text messages aren’t set up on this server yet, so none will be sent.";
  if (info.schoolOff) return "Text messages are switched off in Settings, so none will be sent.";
  const when = "when it is published (on its “show from” day, if that is later)";
  if (to === "school") return info.on.school ? `Every family also gets a text message (SMS) with its title ${when}.` : "No text message is sent for notices to the whole school: that is switched off in Settings.";
  if (to === "staff") return info.on.staff ? `Staff with a mobile number also get a text message (SMS) ${when}.` : "No text message is sent for notices to staff: that is switched off in Settings.";
  const cls = info.on.section;
  const some = info.on.students;
  if (cls && some) return `The families it is for (all of ${to.label}, or only the students you tick) also get a text message (SMS) ${when}.`;
  if (cls) return `The families of ${to.label} also get a text message (SMS) ${when}. Notices to chosen students send none (switched off in Settings).`;
  if (some) return `The families of the students you tick also get a text message (SMS) ${when}. Notices to the whole class send none (switched off in Settings).`;
  return "No text message is sent for class notices: that is switched off in Settings.";
}

/** For a class teacher's notice (posted at once). */
export function classNoticeSmsText(label: string, info: NoticeSmsInfo, editing = false): string {
  if (editing) return "It is already posted, so saving changes sends no new text message.";
  if (info.notSetUp) return "Text messages aren’t set up on this server yet, so none will be sent.";
  if (info.schoolOff) return "Text messages are switched off by the school office, so none will be sent.";
  if (info.on.section && info.on.students) return `The families it is for (all of ${label}, or only the students you tick) also get a text message (SMS) with its title when you post it.`;
  if (info.on.section) return `The families of ${label} also get a text message (SMS) when you post it. Notices to chosen students send no text message.`;
  if (info.on.students) return "The families of the students you tick also get a text message (SMS). Notices to the whole class send no text message.";
  return "No text message is sent for class notices (the school office has switched them off).";
}
