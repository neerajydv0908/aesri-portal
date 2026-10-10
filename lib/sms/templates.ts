/**
 * Text message (SMS) templates.
 *
 * In India every business SMS must match a content template registered on
 * TRAI's DLT system, word for word: only the variable parts may change. So
 * the wording of every message the portal sends lives here, in English and
 * Hindi, and nowhere else. docs/SMS.md and the AESRI "Text messages" page
 * show exactly what to register.
 *
 * In the texts below, {name} is a variable. Since TRAI's direction of 18
 * November 2025 every variable is registered with its type instead of the
 * old generic {#var#}; ours are all {#alphanumeric#} (letters and numbers,
 * up to 40 characters, never a link), and the portal keeps each one to 30
 * characters. Variables are sent to the SMS company in the order they
 * appear in that language's text. Two placeholders are NOT variables but
 * fixed text, filled in before registering:
 *  - {school}: the school's name (its brand). DLT reviewers refuse templates
 *    whose brand is a variable, or that start with a variable — so each
 *    school registers its own copy of every template;
 *  - {portal}: the portal's address, starting https:// (links must be fixed
 *    text and whitelisted on DLT, see smsPortalAddress()).
 * No template starts or ends with a variable, no two variables touch, and
 * none has more than five.
 *
 * Keep templates short: Hindi messages are Unicode, 70 characters for one
 * part (67 per part when longer), English ones 160 (153 per part) as long
 * as they only use GSM characters — so English text here uses plain
 * quotes, hyphens and "..." (never ’ – … or ₹).
 *
 * Nothing here touches the database, so tests and scripts can use it freely.
 */
import { parseMobile } from "@/lib/validation";

export type SmsLang = "en" | "hi";
export const SMS_LANGS: readonly SmsLang[] = ["hi", "en"];
export const SMS_LANG_NAMES: Record<SmsLang, string> = { hi: "Hindi", en: "English" };

/**
 * The longest value the portal puts in a variable. DLT allows 40 in an
 * {#alphanumeric#} variable (30 in the old {#var#}); 30 keeps a margin and
 * the messages short.
 */
export const DLT_VAR_MAX = 30;

/** The DLT variable types the portal uses (TRAI's typed variables). */
export type DltTag = "alphanumeric" | "numeric";

export type VarName =
  | "student"
  | "class"
  | "date"
  | "status"
  | "previous"
  | "kind"
  | "title"
  | "subjects"
  | "exam"
  | "amount"
  | "receipt";

/** How a long value is shortened: "hard" keeps as much as fits (names), "word" stops at a word, "list" keeps whole items of a comma list ("… and 2 more"). */
type Fit = "hard" | "word" | "list";

export type VarSpec = {
  /** What the variable holds, in plain words (shown on the AESRI page). */
  label: string;
  /** How it is registered on DLT: {#alphanumeric#} for text (names, dates, amounts like 5,000, receipt numbers). */
  tag: DltTag;
  /** Longest value sent (never more than DLT_VAR_MAX). */
  max: number;
  fit: Fit;
  /** Free text typed by staff: links, phone numbers and e-mail addresses are taken out (DLT blocks them in variables). */
  freeText?: boolean;
  example: Record<SmsLang, string>;
};

export const VAR_SPECS: Record<VarName, VarSpec> = {
  student: { label: "Student's name", tag: "alphanumeric", max: 22, fit: "hard", freeText: true, example: { en: "Rahul Kumar Meena", hi: "Rahul Kumar Meena" } },
  class: { label: "Class and section", tag: "alphanumeric", max: 12, fit: "hard", example: { en: "IV-A", hi: "IV-A" } },
  date: { label: "Date (DD-MM-YYYY)", tag: "alphanumeric", max: 10, fit: "hard", example: { en: "30-09-2026", hi: "30-09-2026" } },
  status: { label: "Attendance mark", tag: "alphanumeric", max: 16, fit: "hard", example: { en: "absent", hi: "अनुपस्थित" } },
  previous: { label: "Earlier attendance mark", tag: "alphanumeric", max: 16, fit: "hard", example: { en: "absent", hi: "अनुपस्थित" } },
  kind: { label: "Kind of remark", tag: "alphanumeric", max: 16, fit: "hard", example: { en: "appreciation", hi: "सराहना" } },
  title: {
    label: "Notice title (shortened)",
    tag: "alphanumeric",
    max: 30,
    fit: "word",
    freeText: true,
    example: { en: "Dussehra holidays: 19 to 21...", hi: "दशहरा अवकाश: 19 से 21 अक्टूबर" },
  },
  subjects: { label: "Subjects (shortened)", tag: "alphanumeric", max: 30, fit: "list", freeText: true, example: { en: "Hindi, Mathematics, English", hi: "हिंदी, गणित, अंग्रेज़ी" } },
  exam: { label: "Exam name", tag: "alphanumeric", max: 24, fit: "word", freeText: true, example: { en: "Half-yearly", hi: "Half-yearly" } },
  amount: { label: "Amount in rupees", tag: "alphanumeric", max: 14, fit: "hard", example: { en: "5,000", hi: "5,000" } },
  receipt: { label: "Receipt number", tag: "alphanumeric", max: 20, fit: "hard", example: { en: "ARY/26-27/00012", hi: "ARY/26-27/00012" } },
};

export type TemplateKey =
  | "attendance"
  | "attendance_correction"
  | "remark"
  | "notice"
  | "homework"
  | "results"
  | "payment"
  | "payment_cancelled"
  | "cash_declined"
  | "test";

export type SmsTemplate = {
  key: TemplateKey;
  /** Short name for staff screens. */
  name: string;
  /** When it is sent. */
  purpose: string;
  text: Record<SmsLang, string>;
};

/**
 * Every message the portal can send. Changing a text means registering it
 * again on DLT (and entering the new template ID), so change with care.
 */
export const TEMPLATES: Record<TemplateKey, SmsTemplate> = {
  attendance: {
    key: "attendance",
    name: "Attendance",
    purpose: "A student is marked present, absent, late or on leave (today's or yesterday's register).",
    text: {
      en: "{school}: Attendance of {student} ({class}) on {date}: {status}.",
      hi: "{school}: {student} ({class}) की {date} की उपस्थिति: {status}।",
    },
  },
  attendance_correction: {
    key: "attendance_correction",
    name: "Attendance correction",
    purpose: "A mark was changed after the family had already been told.",
    text: {
      en: "{school}: Correction - attendance of {student} ({class}) on {date} is {status}, not {previous}.",
      hi: "{school}: सुधार - {student} ({class}) की {date} की उपस्थिति {status} है, {previous} नहीं।",
    },
  },
  remark: {
    key: "remark",
    name: "Teacher's remark",
    purpose: "A teacher shares a remark with the family. The remark itself is not in the message.",
    text: {
      en: "{school}: A teacher has written a note of {kind} about {student} ({class}). Please read it on {portal}",
      hi: "{school}: {student} ({class}) के लिए शिक्षक की नई टिप्पणी ({kind})। पढ़ें: {portal}",
    },
  },
  notice: {
    key: "notice",
    name: "Notice",
    purpose: "A notice is published for the whole school, a class, chosen students or staff.",
    text: {
      en: '{school}: New notice "{title}". Please read it on {portal}',
      hi: '{school}: नई सूचना "{title}"। कृपया पोर्टल पर पढ़ें: {portal}',
    },
  },
  homework: {
    key: "homework",
    name: "Homework summary",
    purpose: "Once a day at the school's chosen time, for each class that was set homework that day.",
    text: {
      en: "{school}: Homework set on {date} for {class}: {subjects}. Details on {portal}",
      hi: "{school}: {class} का {date} का गृहकार्य: {subjects}। विवरण पोर्टल पर: {portal}",
    },
  },
  results: {
    key: "results",
    name: "Results published",
    purpose: "The office publishes a class's results.",
    text: {
      en: "{school}: The {exam} results of {student} ({class}) are on the portal: {portal}",
      hi: "{school}: {student} ({class}) का {exam} परिणाम पोर्टल पर है: {portal}",
    },
  },
  payment: {
    key: "payment",
    name: "Fee received",
    purpose: "A fee payment is recorded (cash, cheque, bank or online; not opening balances).",
    text: {
      en: "{school}: Received Rs {amount} for {student} on {date}, receipt {receipt}. Thank you.",
      hi: "{school}: {student} के लिए {date} को रु. {amount} प्राप्त हुए, रसीद {receipt}। धन्यवाद।",
    },
  },
  payment_cancelled: {
    key: "payment_cancelled",
    name: "Receipt cancelled",
    purpose: "A receipt the family was told about is cancelled (for example a bounced cheque).",
    text: {
      en: "{school}: Receipt {receipt} of Rs {amount} for {student} has been cancelled. Please contact the school office.",
      hi: "{school}: {student} की रसीद {receipt} (रु. {amount}) रद्द हो गई है। कृपया कार्यालय से संपर्क करें।",
    },
  },
  cash_declined: {
    key: "cash_declined",
    name: "Recorded cash payment declined",
    purpose: "The principal or an office admin declines a cash payment the family recorded on the portal.",
    text: {
      en: "{school}: Your recorded cash payment of Rs {amount} for {student} was declined by the school. Please contact the school office as soon as possible.",
      hi: "{school}: {student} के लिए दर्ज किया गया रु. {amount} का नकद भुगतान विद्यालय ने अस्वीकार कर दिया है। कृपया जल्द से जल्द विद्यालय कार्यालय से संपर्क करें।",
    },
  },
  test: {
    key: "test",
    name: "Test message",
    purpose: "An administrator sends a test message to check the set-up.",
    text: {
      en: "{school}: This is a test message from the school portal. No action is needed. {portal}",
      hi: "{school}: यह विद्यालय पोर्टल का परीक्षण संदेश है। कुछ करने की आवश्यकता नहीं है। {portal}",
    },
  },
};

export const TEMPLATE_KEYS = Object.keys(TEMPLATES) as TemplateKey[];

export function isTemplateKey(v: unknown): v is TemplateKey {
  return typeof v === "string" && Object.hasOwn(TEMPLATES, v);
}

/* ------------------------------------------------------------------ */
/* Words used inside messages                                          */
/* ------------------------------------------------------------------ */

/** Attendance marks as the message says them (the Hindi words are the portal's own labels). */
export const SMS_STATUS_WORDS: Record<"present" | "absent" | "late" | "leave", Record<SmsLang, string>> = {
  present: { en: "present", hi: "उपस्थित" },
  absent: { en: "absent", hi: "अनुपस्थित" },
  late: { en: "late", hi: "देर से" },
  leave: { en: "on leave", hi: "अवकाश" },
};

export const SMS_REMARK_WORDS: Record<"appreciation" | "concern", Record<SmsLang, string>> = {
  appreciation: { en: "appreciation", hi: "सराहना" },
  concern: { en: "concern", hi: "चिंता" },
};

/** "2026-09-30" → "30-09-2026". */
export function smsDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}-${m}-${y}`;
}

/** Paise → "5,000" or "5,000.50" (Indian grouping, no currency sign: the template says Rs / रु.). */
export function smsAmount(paise: number): string {
  const r = paise / 100;
  return r.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 });
}

/* ------------------------------------------------------------------ */
/* Placeholders                                                        */
/* ------------------------------------------------------------------ */

const PLACEHOLDER = /\{([a-z]+)\}/g;

/** The fixed parts written into a school's templates: its name (in the message's language) and the portal's address. */
export type FixedText = { school: string; portal: string };
const FIXED = new Set(["school", "portal"]);

/** The variables of a template in one language, in the order they are sent. */
export function templateVars(key: TemplateKey, lang: SmsLang): VarName[] {
  const out: VarName[] = [];
  for (const m of TEMPLATES[key].text[lang].matchAll(PLACEHOLDER)) {
    if (!FIXED.has(m[1])) out.push(m[1] as VarName);
  }
  return out;
}

/** How a variable is written in the registered wording: {#alphanumeric#}. */
export const dltTag = (name: VarName) => `{#${VAR_SPECS[name].tag}#}`;

/** Any typed DLT variable in a registered wording. */
export const DLT_TAG_PATTERN = /\{#(?:alphanumeric|numeric)#\}/g;

/** The exact wording a school registers on DLT: each variable as its typed tag; its name and the portal address as fixed text. */
export function dltWording(key: TemplateKey, lang: SmsLang, fixed: FixedText): string {
  return TEMPLATES[key].text[lang].replace(PLACEHOLDER, (_, name: string) => (name === "school" ? fixed.school : name === "portal" ? fixed.portal : dltTag(name as VarName)));
}

/* ------------------------------------------------------------------ */
/* Making values safe to send                                          */
/* ------------------------------------------------------------------ */

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
/** Length in characters (code points), as DLT counts them. */
export const charCount = (s: string) => Array.from(s).length;

/** Web links, e-mail addresses and bare domain names ("example.com/x"). */
const LINKS =
  /\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b|\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.(com|in|org|net|co|io|info|biz|me|app|xyz|online|site|edu|gov|ly|ac|us|uk)\b(\/\S*)?/giu;
/** Ten or more digits, allowing spaces or hyphens between them (phone numbers). */
const PHONES = /(\+?91[\s-]?)?(\d[\s-]?){9}\d/g;

/** Characters that turn an English message into a Unicode one (and double its cost), with plain replacements. */
const PLAIN: [RegExp, string][] = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐‑‒–—―−]/g, "-"],
  [/…/g, "..."],
  [/₹\s?/g, "Rs "],
  [/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, " "],
  [/[•·]/g, "-"],
];

/**
 * A value as it may go into a variable: one line, no characters that break
 * the SMS company's request ("|" separates Fast2SMS variables), and — for
 * free text typed by staff — no links, phone numbers or e-mail addresses,
 * which operators block unless they are whitelisted.
 */
export function cleanVar(input: unknown, lang: SmsLang, freeText = false): string {
  let s = String(input ?? "").normalize("NFC");
  if (freeText) s = s.replace(LINKS, " ").replace(PHONES, " ");
  s = s.replace(/[|]/g, "/").replace(/[{}]/g, "").replace(/#{2,}/g, "#");
  if (lang === "en") for (const [re, to] of PLAIN) s = s.replace(re, to);
  // A notice title sits inside the template's quotes: its own double quotes become single ones.
  if (freeText) s = s.replace(/["“”]/g, "'");
  s = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  // A title's own full stop would double the template's; stray punctuation left by a removed link goes too.
  if (freeText) s = s.replace(/[\s,;:.।!?–-]+$/u, "").replace(/^[\s,.;:–-]+/u, "").replace(/\s+([,.;:!?।])/gu, "$1");
  return s;
}

/** Cut to at most `max` characters, never inside a letter (Hindi vowel signs and joined letters stay whole). */
function cutGraphemes(s: string, room: number): string {
  let out = "";
  for (const { segment } of segmenter.segment(s)) {
    if (charCount(out) + charCount(segment) > room) break;
    out += segment;
  }
  return out;
}

/**
 * A value shortened to fit its variable, ending in "…" (Hindi) or "..."
 * (English, so the message stays in the cheaper GSM characters):
 *  - "hard": as much as fits — "Rahul Kumar Mee…";
 *  - "word": stops at the end of a word when that keeps most of the text;
 *  - "list": whole items of a comma list and how many more — "Hindi, Maths and 2 more".
 */
export function fitVar(value: string, max: number, lang: SmsLang, fit: Fit = "word"): string {
  const limit = Math.min(max, DLT_VAR_MAX);
  if (charCount(value) <= limit) return value;
  const ell = lang === "hi" ? "…" : "...";
  const room = limit - charCount(ell);
  if (room <= 0) return cutGraphemes(value, limit);
  if (fit === "list") {
    // Whole items, then how many more: "Hindi, Maths and 2 more" (no dots, so the template's full stop reads well).
    const items = value.split(/\s*,\s*/).filter(Boolean);
    const more = (n: number) => (lang === "hi" ? ` और ${n} अन्य` : ` and ${n} more`);
    for (let k = items.length - 1; k >= 1; k--) {
      const text = items.slice(0, k).join(", ") + more(items.length - k);
      if (charCount(text) <= limit) return text;
    }
    // Even the first item is too long: shorten it like a word.
    return fitVar(items[0] ?? value, max, lang, "word");
  }
  let out = cutGraphemes(value, room);
  if (fit === "word") {
    // Stop at the end of a word, unless the cut already falls between two words or that would lose too much.
    const rest = value.slice(out.length);
    const space = out.lastIndexOf(" ");
    if (rest && !/^\s/.test(rest) && space >= Math.floor(room * 0.6)) out = out.slice(0, space);
  }
  out = out.replace(/[\s,.;:/(–-]+$/u, "");
  return out + ell;
}

/** Clean and shorten one variable of a template. */
export function prepareVar(name: VarName, value: unknown, lang: SmsLang): string {
  const spec = VAR_SPECS[name];
  return fitVar(cleanVar(value, lang, spec.freeText), spec.max, lang, spec.fit);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export type RenderedSms = {
  /** The variables in the order the SMS company expects them. */
  vars: string[];
  /** The message as the family receives it. */
  body: string;
};

/** Free text a value may be replaced by if cleaning left nothing (a title that was only a link, say). */
const EMPTY_FALLBACK: Partial<Record<VarName, Record<SmsLang, string>>> = {
  title: { en: "School notice", hi: "विद्यालय की सूचना" },
  subjects: { en: "see the portal", hi: "पोर्टल देखें" },
  exam: { en: "exam", hi: "परीक्षा" },
};

/**
 * Fill in a school's template. Every variable of the template must be
 * given; each is cleaned and shortened to its limit. `fixed` holds the
 * school's name and the portal address, exactly as registered.
 */
export function renderSms(key: TemplateKey, lang: SmsLang, values: Partial<Record<VarName, unknown>>, fixed: FixedText): RenderedSms {
  const names = templateVars(key, lang);
  const prepared = new Map<string, string>();
  for (const name of names) {
    const raw = values[name];
    if (raw === undefined || raw === null || String(raw).trim() === "") throw new Error(`SMS template "${key}" needs a value for {${name}}.`);
    const v = prepareVar(name, raw, lang) || EMPTY_FALLBACK[name]?.[lang];
    if (!v) throw new Error(`SMS template "${key}": the value for {${name}} is empty once cleaned.`);
    prepared.set(name, v);
  }
  const body = TEMPLATES[key].text[lang].replace(PLACEHOLDER, (_, name: string) =>
    name === "school" ? fixed.school : name === "portal" ? fixed.portal : (prepared.get(name) ?? ""),
  );
  return { vars: names.map((n) => prepared.get(n)!), body };
}

/** The example message for a template (for the AESRI page and the docs). */
export function exampleSms(key: TemplateKey, lang: SmsLang, fixed: FixedText): RenderedSms {
  const values: Partial<Record<VarName, string>> = {};
  for (const name of templateVars(key, lang)) values[name] = VAR_SPECS[name].example[lang];
  if (key === "attendance_correction") values.status = SMS_STATUS_WORDS.present[lang];
  if (key === "notice") values.title = lang === "hi" ? "दशहरा अवकाश: 19 से 21 अक्टूबर" : "Dussehra holidays: 19 to 21 October";
  return renderSms(key, lang, values, fixed);
}

/* ------------------------------------------------------------------ */
/* Length and cost                                                     */
/* ------------------------------------------------------------------ */

const GSM_BASIC = new Set(
  Array.from("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"),
);
const GSM_EXTENDED = new Set(Array.from("^{}\\[~]|€\f"));

export type SmsSize = { encoding: "gsm" | "unicode"; length: number; parts: number };

/**
 * How long a message is and how many parts (each billed as one SMS) it
 * takes: plain English (GSM characters) 160 in one part, 153 per part when
 * longer; anything else (Hindi) is Unicode: 70, then 67 per part.
 */
export function smsSize(text: string): SmsSize {
  let septets = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM_BASIC.has(ch)) septets += 1;
    else if (GSM_EXTENDED.has(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return { encoding: "gsm", length: septets, parts: septets <= 160 ? 1 : Math.ceil(septets / 153) };
  const units = text.length; // UTF-16 code units, as phones count them
  return { encoding: "unicode", length: units, parts: units <= 70 ? 1 : Math.ceil(units / 67) };
}

/* ------------------------------------------------------------------ */
/* Mobile numbers                                                      */
/* ------------------------------------------------------------------ */

/** A 10-digit Indian mobile number (starting 6–9), or null (see parseMobile). */
export function validMobile(input: string | null | undefined): string | null {
  const m = parseMobile(input);
  return m && m !== "invalid" ? m : null;
}

/** "98•••••12": enough to recognise a number, not enough to copy it. */
export function maskMobile(mobile: string | null | undefined): string {
  const m = (mobile ?? "").replace(/\D/g, "");
  if (m.length < 4) return "—";
  return `${m.slice(0, 2)}•••••${m.slice(-2)}`;
}
