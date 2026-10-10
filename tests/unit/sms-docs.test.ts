/**
 * docs/SMS.md lists the wording each school registers on DLT. This keeps
 * that list in step with lib/sms/templates.ts: a changed wording must be
 * registered again, so the guide must show the new one.
 *
 * The guides are kept out of the public repository (.gitignore), so in a
 * copy without docs/SMS.md these checks are skipped rather than failed.
 *
 *   node --import tsx --test tests/unit/sms-docs.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { SCHOOLS } from "../../lib/services/reference";
import { dltWording, SMS_LANGS, TEMPLATE_KEYS, TEMPLATES } from "../../lib/sms/templates";

const DOC = path.join(__dirname, "..", "..", "docs", "SMS.md");
const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, "utf8") : "";
const skip = doc ? false : "docs/SMS.md isn't in this copy (the guides are private)";
const PORTAL = "https://portal.aesri.org";

test("docs/SMS.md shows every wording, for each school and language, exactly as the portal sends it", { skip }, () => {
  for (const s of SCHOOLS) {
    for (const key of TEMPLATE_KEYS) {
      for (const lang of SMS_LANGS) {
        const wording = dltWording(key, lang, { school: lang === "hi" ? s.nameHi : s.name, portal: PORTAL });
        assert.ok(doc.includes("```text\n" + wording + "\n```"), `${s.id} ${key}/${lang} is missing or different:\n${wording}`);
      }
    }
  }
});

test("docs/SMS.md has no wording the portal no longer sends", { skip }, () => {
  const blocks = [...doc.matchAll(/```text\n([^\n]*)\n```/g)].map((m) => m[1]);
  assert.equal(blocks.length, SCHOOLS.length * TEMPLATE_KEYS.length * SMS_LANGS.length);
  for (const key of TEMPLATE_KEYS) assert.ok(doc.includes(`### ${TEMPLATES[key].name} (\`${key}\`)`), key);
});
