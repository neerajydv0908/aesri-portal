/**
 * lib/sms/templates.ts: every template renders in English and Hindi, every
 * variable stays within DLT's 30 characters (shortened sensibly), links and
 * phone numbers never reach a variable, and message sizes are counted the
 * way phones count them.
 *
 *   node --import tsx --test tests/unit/sms-templates.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DLT_TAG_PATTERN,
  DLT_VAR_MAX,
  SMS_LANGS,
  TEMPLATE_KEYS,
  TEMPLATES,
  VAR_SPECS,
  charCount,
  cleanVar,
  dltWording,
  exampleSms,
  fitVar,
  maskMobile,
  prepareVar,
  renderSms,
  smsAmount,
  smsDate,
  smsSize,
  templateVars,
  validMobile,
  type FixedText,
  type SmsLang,
} from "../../lib/sms/templates";

const PORTAL = "https://portal.aesri.org";
/** What a school writes into its own templates: its name (in the message's language) and the portal address. */
const FIXED: Record<SmsLang, FixedText> = {
  en: { school: "Aryavart Public School", portal: PORTAL },
  hi: { school: "आर्यवर्त पब्लिक स्कूल", portal: PORTAL },
};

test("every template has both languages, the same variables in each, none twice, and nothing else in braces", () => {
  for (const key of TEMPLATE_KEYS) {
    const en = templateVars(key, "en");
    const hi = templateVars(key, "hi");
    assert.deepEqual([...en].sort(), [...hi].sort(), `${key}: same variables in English and Hindi`);
    assert.equal(new Set(en).size, en.length, `${key}: no variable twice`);
    for (const lang of SMS_LANGS) {
      const wording = dltWording(key, lang, FIXED[lang]);
      assert.ok(!/[{}]/.test(wording.replace(DLT_TAG_PATTERN, "")), `${key}/${lang}: only typed DLT variables in braces`);
      assert.ok(!wording.includes("{#var#}"), "the generic {#var#} is no longer accepted for new templates");
      assert.equal((wording.match(DLT_TAG_PATTERN) ?? []).length, templateVars(key, lang).length);
      for (const v of templateVars(key, lang)) assert.ok(VAR_SPECS[v].max <= DLT_VAR_MAX, `${v} max ≤ 30`);
    }
  }
});

test("English wordings use only plain (GSM) characters, so an English SMS costs one part per 160 characters", () => {
  for (const key of TEMPLATE_KEYS) {
    const size = smsSize(dltWording(key, "en", FIXED.en));
    assert.equal(size.encoding, "gsm", `${key}: ${TEMPLATES[key].text.en}`);
    assert.equal(smsSize(exampleSms(key, "en", FIXED.en).body).encoding, "gsm", `${key}: example stays GSM`);
  }
});

test("the school's name and the portal address are fixed text in the wording, not variables", () => {
  assert.equal(dltWording("notice", "en", FIXED.en), 'Aryavart Public School: New notice "{#alphanumeric#}". Please read it on https://portal.aesri.org');
  assert.equal(dltWording("notice", "hi", FIXED.hi), 'आर्यवर्त पब्लिक स्कूल: नई सूचना "{#alphanumeric#}"। कृपया पोर्टल पर पढ़ें: https://portal.aesri.org');
  assert.ok(!templateVars("remark", "en").includes("portal" as never));
  assert.ok(!templateVars("attendance", "hi").includes("school" as never));
  assert.equal(dltWording("test", "en", FIXED.en), "Aryavart Public School: This is a test message from the school portal. No action is needed. https://portal.aesri.org");
});

test("DLT rules: each template starts with the school's name, never starts or ends with a variable, has no two variables side by side, at most five, and only the portal as a link", () => {
  for (const key of TEMPLATE_KEYS) {
    for (const lang of SMS_LANGS) {
      const w = dltWording(key, lang, FIXED[lang]);
      const where = `${key}/${lang}: ${w}`;
      assert.ok(w.startsWith(`${FIXED[lang].school}: `), where);
      assert.ok(!/\{#[a-z]+#\}$/.test(w), where);
      const parts = w.split(DLT_TAG_PATTERN);
      assert.ok(parts.length - 1 <= 5, `${where}: at most five variables`);
      for (const between of parts.slice(1, -1)) assert.ok(between.trim().length > 0, `${where}: variables must be separated by fixed text`);
      for (const link of w.match(/https?:\/\/\S+|www\.\S+/g) ?? []) assert.equal(link, PORTAL, where);
      // Each school's copy differs only in its name.
      const other = dltWording(key, lang, { ...FIXED[lang], school: "Aadharshila Public School" });
      assert.equal(other.replace("Aadharshila Public School", FIXED[lang].school), w);
    }
  }
});

test("rendering fills the variables in the order of each language's wording", () => {
  const values = { student: "Rahul Kumar Meena", class: "IV-A", date: "30-09-2026", status: "absent" };
  const en = renderSms("attendance", "en", values, FIXED.en);
  assert.equal(en.body, "Aryavart Public School: Attendance of Rahul Kumar Meena (IV-A) on 30-09-2026: absent.");
  assert.deepEqual(en.vars, ["Rahul Kumar Meena", "IV-A", "30-09-2026", "absent"]);
  const hi = renderSms("attendance", "hi", { ...values, status: "अनुपस्थित" }, FIXED.hi);
  assert.equal(hi.body, "आर्यवर्त पब्लिक स्कूल: Rahul Kumar Meena (IV-A) की 30-09-2026 की उपस्थिति: अनुपस्थित।");
  assert.deepEqual(hi.vars, ["Rahul Kumar Meena", "IV-A", "30-09-2026", "अनुपस्थित"]);
  // The order of variables follows each language's wording (payment: date before amount in Hindi).
  assert.deepEqual(templateVars("payment", "en"), ["amount", "student", "date", "receipt"]);
  assert.deepEqual(templateVars("payment", "hi"), ["student", "date", "amount", "receipt"]);
  // A value missing is a programming error, never a half-empty message.
  assert.throws(() => renderSms("attendance", "en", { ...values, status: "" }, FIXED.en), /needs a value for \{status\}/);
  // A title that was only a link still says something.
  assert.deepEqual(renderSms("notice", "en", { title: "https://example.com/x" }, FIXED.en).vars, ["School notice"]);
});

test("the rendered body is exactly the registered wording with the variables put in", () => {
  for (const key of TEMPLATE_KEYS) {
    for (const lang of SMS_LANGS) {
      const ex = exampleSms(key, lang, FIXED[lang]);
      const parts = dltWording(key, lang, FIXED[lang]).split(DLT_TAG_PATTERN);
      let rebuilt = parts[0];
      ex.vars.forEach((v, i) => (rebuilt += v + parts[i + 1]));
      assert.equal(ex.body, rebuilt, `${key}/${lang}`);
    }
  }
});

test("long values are shortened to their limit, never past 30 characters, with an ellipsis", () => {
  // Names: as much as fits (the family still recognises it).
  assert.equal(fitVar("Rahul Kumar Meena", 16, "hi", "hard"), "Rahul Kumar Mee…");
  assert.equal(fitVar("Rahul Kumar Meena", 16, "en", "hard"), "Rahul Kumar M...");
  const name = prepareVar("student", "Mohammed Irfan Abdul Rahman Qureshi", "en");
  assert.ok(charCount(name) <= VAR_SPECS.student.max && name.endsWith("..."), name);
  // Titles: stop at a word (and their own quotes can't close the template's).
  assert.equal(prepareVar("title", "Dussehra holidays: 19 to 21 October, school reopens 22nd", "en"), "Dussehra holidays: 19 to 21...");
  assert.equal(prepareVar("title", 'The "Annual Day" rehearsal', "en"), "The 'Annual Day' rehearsal");
  const hiTitle = prepareVar("title", "दशहरा अवकाश: 19 से 21 अक्टूबर तक विद्यालय बंद रहेगा", "hi");
  assert.ok(charCount(hiTitle) <= 30 && hiTitle.endsWith("…"), hiTitle);
  // Subject lists: whole subjects, then how many more.
  assert.equal(prepareVar("subjects", "Hindi, Mathematics, English", "en"), "Hindi, Mathematics, English");
  assert.equal(prepareVar("subjects", "Hindi, Mathematics, English, Environmental Education, Sanskrit", "en"), "Hindi, Mathematics and 3 more");
  assert.equal(prepareVar("subjects", "हिंदी, गणित, अंग्रेज़ी, पर्यावरण शिक्षा, संस्कृत", "hi"), "हिंदी, गणित और 3 अन्य");
  assert.equal(prepareVar("subjects", "Socially Useful and Productive Work, Hindi", "en"), "Socially Useful and...");
  // Anything, any language: never more than 30.
  for (const lang of SMS_LANGS) {
    for (const name of Object.keys(VAR_SPECS) as (keyof typeof VAR_SPECS)[]) {
      const v = prepareVar(name, "क्षत्रिय ".repeat(20) + "x".repeat(50), lang);
      assert.ok(charCount(v) <= VAR_SPECS[name].max && charCount(v) <= DLT_VAR_MAX, `${name}/${lang}: ${v}`);
    }
  }
});

test("Hindi is never cut inside a letter (vowel signs and joined letters stay whole)", () => {
  const text = "क्षत्रिय विद्यार्थी श्रीमान";
  const graphemes = Array.from(new Intl.Segmenter("hi", { granularity: "grapheme" }).segment(text), (g) => g.segment);
  const boundaries = new Set(graphemes.map((_, i) => graphemes.slice(0, i + 1).join("")));
  for (let max = 4; max <= 26; max++) {
    const v = fitVar(text, max, "hi", "hard");
    const kept = v.replace(/…$/, "");
    assert.ok(charCount(v) <= max, `${max}: ${v}`);
    assert.ok(boundaries.has(kept), `${max}: "${kept}" is not a whole number of letters`);
  }
});

test("links, e-mail addresses and phone numbers are taken out of free text (DLT blocks them in variables)", () => {
  assert.equal(cleanVar("PTM on Saturday, see https://example.com/ptm for times", "en", true), "PTM on Saturday, see for times");
  assert.equal(cleanVar("Fees: pay at www.pay-fees.in today", "en", true), "Fees: pay at today");
  assert.equal(cleanVar("Call 98765 43210 or +91-9876543210 for the bus", "en", true), "Call or for the bus");
  assert.equal(cleanVar("Mail office@school.org now", "en", true), "Mail now");
  assert.equal(cleanVar("Results on aesri.org/results.", "en", true), "Results on");
  // Not free text (names, class labels): left alone apart from tidying.
  assert.equal(cleanVar("  Rahul   Kumar ", "en"), "Rahul Kumar");
});

test("variables can't break the SMS company's request, and English stays in plain characters", () => {
  assert.equal(cleanVar("A|B {C}", "en"), "A/B C");
  assert.equal(cleanVar("Parent’s “day” – ₹500…", "en", true), "Parent's 'day' - Rs 500");
  assert.equal(cleanVar("line one\nline two\ttab", "hi"), "line one line two tab");
  assert.equal(smsSize(`Dear parent, ${cleanVar("Parent’s day – ₹500", "en", true)}`).encoding, "gsm");
});

test("message sizes: GSM 160 / 153 per part, Unicode 70 / 67 per part", () => {
  assert.deepEqual(smsSize("a".repeat(160)), { encoding: "gsm", length: 160, parts: 1 });
  assert.deepEqual(smsSize("a".repeat(161)), { encoding: "gsm", length: 161, parts: 2 });
  assert.equal(smsSize("a".repeat(306)).parts, 2);
  assert.equal(smsSize("a".repeat(307)).parts, 3);
  assert.equal(smsSize("[]").length, 4, "extension characters count twice");
  assert.deepEqual(smsSize("क".repeat(70)), { encoding: "unicode", length: 70, parts: 1 });
  assert.deepEqual(smsSize("क".repeat(71)), { encoding: "unicode", length: 71, parts: 2 });
  assert.equal(smsSize("क".repeat(134)).parts, 2);
  assert.equal(smsSize("क".repeat(135)).parts, 3);
  // The examples: English attendance fits in one SMS, Hindi in two.
  assert.equal(smsSize(exampleSms("attendance", "en", FIXED.en).body).parts, 1);
  assert.equal(smsSize(exampleSms("attendance", "hi", FIXED.hi).body).parts, 2);
});

test("dates, amounts and numbers", () => {
  assert.equal(smsDate("2026-09-30"), "30-09-2026");
  assert.equal(smsAmount(5_000_00), "5,000");
  assert.equal(smsAmount(1_25_000_50), "1,25,000.50");
  assert.equal(validMobile("+91 98765-43210"), "9876543210");
  assert.equal(validMobile("09876543210"), "9876543210");
  assert.equal(validMobile("12345"), null);
  assert.equal(validMobile("5876543210"), null);
  assert.equal(validMobile(null), null);
  assert.equal(maskMobile("9876543210"), "98•••••10");
});
