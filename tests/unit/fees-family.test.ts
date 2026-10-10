/**
 * What a family may pay (lib/services/fees.ts): the admission fee — charged
 * once, when a child joins — as one fixed sum; tuition in any amount from
 * ₹1,000 (or what is left, when that is less) up to what is left for the
 * session, counting cash payments the family recorded that wait for the
 * school's approval (which never lower the ₹1,000); and how money is split
 * across fee lines.
 *
 *   node --import tsx --test tests/unit/fees-family.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { allocate, amountInWordsHi, checkFamilyChoice, familyPayable, MIN_TUITION_PAYMENT, numberInWordsHi, type FamilyPayable } from "../../lib/services/fees";

const TODAY = "2026-10-02";
const r = (rupees: number) => rupees * 100;

/** Class X: Term I and Term II of ₹9,000 each, and the ₹2,000 admission fee (the "9 + 9 + 2"). */
const classX = (paid: { adm?: number; t1?: number; t2?: number } = {}) => [
  { id: "adm", kind: "admission" as const, outstanding: r(2000) - (paid.adm ?? 0), dueOn: "2026-04-01" },
  { id: "t1", kind: "instalment" as const, outstanding: r(9000) - (paid.t1 ?? 0), dueOn: "2026-04-10" },
  { id: "t2", kind: "instalment" as const, outstanding: r(9000) - (paid.t2 ?? 0), dueOn: "2026-09-15" },
];

const ok = (p: FamilyPayable, admission: boolean, tuition: number) => {
  const c = checkFamilyChoice(p, { admission, tuition });
  assert.ok(c.ok, `expected ok, got ${c.ok ? "" : c.problem}`);
  return c.value;
};
const problem = (p: FamilyPayable, admission: boolean, tuition: number) => {
  const c = checkFamilyChoice(p, { admission, tuition });
  assert.ok(!c.ok, "expected a problem");
  return c.problem;
};

test("the minimum tuition payment is ₹1,000", () => {
  assert.equal(MIN_TUITION_PAYMENT, r(1000));
});

test("the admission fee is one fixed sum; tuition is any amount from ₹1,000 to what is left", () => {
  const p = familyPayable(classX(), [], TODAY);
  assert.deepEqual(p.admission, { amount: r(2000), chargeIds: ["adm"] });
  assert.deepEqual(p.tuition, { min: r(1000), max: r(18000), dueNow: r(18000), chargeIds: ["t1", "t2"] });
  // Not 9 + 9 + 2 any more: ₹2,000 admission and ₹3,500 of tuition, admission first.
  assert.deepEqual(ok(p, true, r(3500)), { amount: r(5500), admissionAmount: r(2000), tuitionAmount: r(3500), chargeIds: ["adm", "t1", "t2"] });
  assert.deepEqual(ok(p, false, r(1000)), { amount: r(1000), admissionAmount: 0, tuitionAmount: r(1000), chargeIds: ["t1", "t2"] });
  assert.deepEqual(ok(p, true, 0), { amount: r(2000), admissionAmount: r(2000), tuitionAmount: 0, chargeIds: ["adm"] });
  assert.equal(ok(p, false, r(18000)).amount, r(18000));
  assert.equal(problem(p, false, r(999)), "tuition_small");
  assert.equal(problem(p, false, r(18000) + 1), "tuition_large");
  assert.equal(problem(p, false, 0), "nothing");
  assert.equal(problem(p, false, -5), "tuition_small");
  assert.equal(problem(p, false, 0.5), "tuition_small");
});

test("when less than ₹1,000 of tuition is left, that is the amount to pay", () => {
  const p = familyPayable(classX({ adm: r(2000), t1: r(9000), t2: r(8400) }), [], TODAY);
  assert.equal(p.admission, null);
  assert.deepEqual(p.tuition, { min: r(600), max: r(600), dueNow: r(600), chargeIds: ["t2"] });
  assert.equal(ok(p, false, r(600)).amount, r(600));
  assert.equal(problem(p, false, r(500)), "tuition_small");
  assert.equal(problem(p, true, r(600)), "admission_gone");
});

test("a part-paid admission fee is paid as what is left of it", () => {
  const p = familyPayable(classX({ adm: r(500) }), [], TODAY);
  assert.deepEqual(p.admission, { amount: r(1500), chargeIds: ["adm"] });
});

test("only fees that have fallen due count as due now", () => {
  const p = familyPayable(classX(), [], "2026-05-01");
  assert.equal(p.tuition?.dueNow, r(9000));
  assert.equal(p.tuition?.max, r(18000));
  assert.equal(familyPayable(classX(), [], "2026-04-01").tuition?.dueNow, 0);
});

test("cash payments waiting for approval are not asked for again", () => {
  // ₹2,000 admission + ₹5,000 tuition recorded and waiting.
  const p = familyPayable(classX(), [{ amount: r(7000), admissionAmount: r(2000) }], TODAY);
  assert.equal(p.admission, null);
  assert.deepEqual(p.tuition, { min: r(1000), max: r(13000), dueNow: r(13000), chargeIds: ["t1", "t2"] });
  assert.deepEqual(p.pending, { admission: r(2000), tuition: r(5000) });
  assert.equal(problem(p, true, 0), "admission_gone");
  // Everything recorded: nothing left to offer.
  const all = familyPayable(classX(), [{ amount: r(20000), admissionAmount: r(2000) }], TODAY);
  assert.equal(all.admission, null);
  assert.equal(all.tuition, null);
  assert.equal(all.held, 0);
  assert.equal(problem(all, false, r(1000)), "tuition_gone");
});

test("a cash payment waiting for approval never makes a payment below ₹1,000 possible", () => {
  // ₹17,700 recorded and waiting leaves ₹300: that waits until the record is decided (it could be withdrawn).
  const p = familyPayable(classX(), [{ amount: r(17700), admissionAmount: 0 }], TODAY);
  assert.equal(p.tuition, null);
  assert.equal(p.held, r(300));
  assert.equal(problem(p, false, r(300)), "tuition_gone");
  // ₹17,000 waiting leaves exactly ₹1,000, which can be paid.
  assert.deepEqual(familyPayable(classX(), [{ amount: r(17000), admissionAmount: 0 }], TODAY).tuition, { min: r(1000), max: r(1000), dueNow: r(1000), chargeIds: ["t1", "t2"] });
  // Less than ₹1,000 left with nothing waiting: that is still the amount to pay.
  const small = familyPayable(classX({ t1: r(9000), t2: r(8400) }), [], TODAY);
  assert.equal(small.tuition?.min, r(600));
  assert.equal(small.held, 0);
});

test("paid-up, waived and RTE lines offer nothing", () => {
  const p = familyPayable(classX({ adm: r(2000), t1: r(9000), t2: r(9000) }), [], TODAY);
  assert.equal(p.admission, null);
  assert.equal(p.tuition, null);
  assert.equal(problem(p, false, 0), "nothing");
});

test("allocation pays the chosen lines first, in the order given, then the oldest dues", () => {
  const open = [
    { id: "t1", outstanding: r(9000) },
    { id: "t2", outstanding: r(9000) },
    { id: "adm", outstanding: r(2000) },
  ];
  assert.deepEqual(allocate(open, r(5500), ["adm", "t1", "t2"]), {
    allocations: [
      { chargeId: "adm", amount: r(2000) },
      { chargeId: "t1", amount: r(3500) },
    ],
    excess: 0,
  });
  // Without a preference: oldest first.
  assert.deepEqual(allocate(open, r(10000)).allocations, [
    { chargeId: "t1", amount: r(9000) },
    { chargeId: "t2", amount: r(1000) },
  ]);
  // Chosen lines that are no longer open are skipped; money beyond everything due is left over.
  assert.deepEqual(allocate([{ id: "t2", outstanding: r(1000) }], r(1500), ["gone", "t2"]), { allocations: [{ chargeId: "t2", amount: r(1000) }], excess: r(500) });
  assert.deepEqual(allocate(open, 0), { allocations: [], excess: 0 });
});

test("receipts give the amount in words in Hindi too", () => {
  assert.equal(numberInWordsHi(0), "शून्य");
  assert.equal(numberInWordsHi(45), "पैंतालीस");
  assert.equal(numberInWordsHi(99), "निन्यानवे");
  assert.equal(numberInWordsHi(250), "दो सौ पचास");
  assert.equal(numberInWordsHi(18000), "अठारह हज़ार");
  assert.equal(numberInWordsHi(125000), "एक लाख पच्चीस हज़ार");
  assert.equal(numberInWordsHi(123456789), "बारह करोड़ चौंतीस लाख छप्पन हज़ार सात सौ नवासी");
  assert.equal(amountInWordsHi(r(5000)), "पाँच हज़ार रुपये मात्र");
  assert.equal(amountInWordsHi(1250050), "बारह हज़ार पाँच सौ रुपये और पचास पैसे मात्र");
  assert.equal(amountInWordsHi(50), "पचास पैसे मात्र");
  // Every number below a hundred has its own word.
  const words = new Set(Array.from({ length: 100 }, (_, i) => numberInWordsHi(i)));
  assert.equal(words.size, 100);
  for (const w of words) assert.match(w, /^[ऀ-ॿ]+$/u);
});
