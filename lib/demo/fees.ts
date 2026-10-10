/**
 * Demo data: Fee payments and receipts. Fictional only — see lib/demo/core.ts.
 *
 * The story: the portal went live on 1 September. That day the office
 * brought forward what families had already paid on paper (opening
 * balances): Term I for almost everyone, Term II for a few early payers, and
 * the admission fee for this year's new admissions. Since then Term II (due
 * 15 September) has been collected at the counter by cash, cheque and bank
 * transfer, and a few families paid online through the test checkout. About
 * one family in seven still owes Term II; two have paid part of it, and one
 * cheque bounced and was reversed.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { accounts, paymentOrders, studentCharges, students } from "@/lib/db/schema";
import type { AuditActor } from "@/lib/audit";
import { addDays, todayIST } from "@/lib/dates";
import { displayLoginId } from "@/lib/ids";
import { mockGateway } from "@/lib/payments/mock";
import { addAdmissionCharge, ledgerLinesFor, recordOpeningBalances, recordPayment, reversePayment, type LedgerCharge, type OpeningEntry } from "@/lib/services/fees";
import { confirmOrderPayment } from "@/lib/services/payments";
import { CURRENT_SESSION } from "@/lib/services/reference";
import type { DemoContext } from "./core";

/** Small deterministic "random" so the demo is the same every time. */
function rng(seed: number) {
  let x = (seed * 2654435761) % 2 ** 32;
  return () => {
    x = (x * 1664525 + 1013904223) % 2 ** 32;
    return x / 2 ** 32;
  };
}

type CounterEvent = {
  date: string;
  studentId: string;
  line: LedgerCharge;
  amount: number;
  method: "cash" | "cheque" | "bank" | "online";
  reference: string | null;
  bounce?: boolean;
};

async function actorFor(tx: Tx, staffId: string): Promise<AuditActor> {
  const [a] = await tx.select({ id: accounts.id, loginId: accounts.loginId }).from(accounts).where(eq(accounts.staffId, staffId));
  return { accountId: a.id, loginId: displayLoginId(a.loginId), ip: null };
}

export async function seedDemoFees(tx: Tx, ctx: DemoContext): Promise<string[]> {
  const log: string[] = [];
  const today = todayIST();
  const goLive = today >= "2026-09-02" ? "2026-09-01" : addDays(today, -1);
  const firstCounterDay = addDays(goLive, 1);
  const span = Math.max(1, Math.round((Date.parse(today) - Date.parse(firstCounterDay)) / 86_400_000) + 1);

  for (const [si, school] of ctx.schools.entries()) {
    const r = rng(101 + si * 17);
    const office = await actorFor(tx, school.accountantId);
    const principal = await actorFor(tx, school.principalId);
    const studentIds = school.sections.flatMap((s) => s.studentIds);
    const people = await tx.select({ id: students.id, rte: students.rte, admittedOn: students.admittedOn }).from(students).where(inArray(students.id, studentIds));
    const familyAccounts = await tx
      .select({ id: accounts.id, loginId: accounts.loginId, studentId: accounts.studentId })
      .from(accounts)
      .where(inArray(accounts.studentId, studentIds));
    const familyOf = new Map(familyAccounts.map((a) => [a.studentId!, a]));

    // This year's new admissions owe the one-time admission fee, due on the day they joined.
    for (const p of people) {
      if (!p.admittedOn || p.admittedOn < CURRENT_SESSION.startsOn) continue;
      await addAdmissionCharge(tx, p.id, ctx.sessionId, office);
      await tx
        .update(studentCharges)
        .set({ dueOn: p.admittedOn })
        .where(and(eq(studentCharges.studentId, p.id), eq(studentCharges.kind, "admission")));
    }

    const lines = await ledgerLinesFor(tx, studentIds, ctx.sessionId);
    const opening: OpeningEntry[] = [];
    const counter: CounterEvent[] = [];
    let owing = 0;
    let partials = 0;
    let bounced = 0;

    for (const p of people) {
      if (p.rte) continue; // RTE seat: every line is waived
      const own = lines.get(p.id) ?? [];
      const term1 = own.find((l) => l.kind === "instalment" && l.label.startsWith("Term I —"));
      const term2 = own.find((l) => l.kind === "instalment" && l.label.startsWith("Term II —"));
      const admission = own.find((l) => l.kind === "admission" && !l.waived);
      if (!term1 || !term2) continue;
      if (admission && r() < 0.9) opening.push({ chargeId: admission.id, paid: "full" });

      const x = r();
      if (x < 0.025) {
        owing++; // has paid nothing this year
        continue;
      }
      opening.push({ chargeId: term1.id, paid: "full" });
      if (x < 0.16) {
        owing++;
        if (partials < 1 + si) {
          partials++;
          counter.push({ date: addDays(firstCounterDay, 10 + partials * 3), studentId: p.id, line: term2, amount: 2_000_00, method: "cash", reference: null });
        } else if (si === 0 && bounced === 0) {
          bounced++;
          counter.push({
            date: addDays(firstCounterDay, 13),
            studentId: p.id,
            line: term2,
            amount: term2.amount,
            method: "cheque",
            reference: `Cheque 0${412000 + Math.floor(r() * 900)}, Bank of Baroda, Bikaner`,
            bounce: true,
          });
        }
        continue;
      }
      if (x < 0.26) {
        opening.push({ chargeId: term2.id, paid: "full" }); // paid Term II early, on paper
        continue;
      }
      // Term II at the counter (or online) after the portal opened; most around the due date.
      const m = r();
      const method = m < 0.68 ? "cash" : m < 0.84 ? "cheque" : m < 0.92 ? "bank" : "online";
      const skew = r() < 0.7 ? r() * 0.55 : r();
      const date = addDays(firstCounterDay, Math.min(span - 1, Math.floor(skew * span)));
      const reference =
        method === "cheque"
          ? `Cheque 0${310000 + Math.floor(r() * 90000)}, ${r() < 0.5 ? "State Bank of India" : "Bank of Baroda"}, Bikaner`
          : method === "bank"
            ? `UTR SBIN0${Math.floor(100000000 + r() * 899999999)}`
            : null;
      counter.push({ date, studentId: p.id, line: term2, amount: term2.amount, method, reference });
    }

    // A few receipts dated today, so the day's collection report has something in it.
    const later = counter.filter((c) => !c.bounce && c.amount === c.line.amount).slice(-4);
    for (const c of later) c.date = today;

    const ob = await recordOpeningBalances(
      tx,
      { schoolId: school.schoolId, sessionId: ctx.sessionId, paidOn: goLive, reference: "Brought forward from the paper receipt book", entries: opening },
      office,
    );

    counter.sort((a, b) => a.date.localeCompare(b.date) || a.studentId.localeCompare(b.studentId));
    let online = 0;
    for (const c of counter) {
      if (c.method === "online") {
        // The family's own payment through the test checkout, confirmed the same way as a real one.
        const fam = familyOf.get(c.studentId)!;
        const g = await mockGateway.createOrder({ orderId: "demo", amount: c.amount, notes: {} });
        const [order] = await tx
          .insert(paymentOrders)
          .values({
            schoolId: school.schoolId,
            studentId: c.studentId,
            amount: c.amount,
            chargeIds: [c.line.id],
            provider: "mock",
            providerOrderId: g.providerOrderId,
            createdBy: fam.id,
            createdAt: new Date(`${c.date}T11:20:00+05:30`),
          })
          .returning({ id: paymentOrders.id });
        const paymentId = mockGateway.newPaymentId();
        if (!mockGateway.verifyCheckoutSignature(g.providerOrderId, paymentId, mockGateway.signCheckout(g.providerOrderId, paymentId)))
          throw new Error("Demo: mock signature check failed");
        await confirmOrderPayment(
          tx,
          order.id,
          { id: paymentId, amount: c.amount, currency: "INR", method: "upi", paidOn: c.date },
          { accountId: fam.id, loginId: displayLoginId(fam.loginId), ip: null },
        );
        online++;
        continue;
      }
      const rec = await recordPayment(
        tx,
        {
          schoolId: school.schoolId,
          studentId: c.studentId,
          sessionId: ctx.sessionId,
          amount: c.amount,
          method: c.method,
          reference: c.reference,
          paidOn: c.date,
          chargeIds: [c.line.id],
        },
        office,
      );
      if (c.bounce) await reversePayment(tx, rec.id, school.schoolId, "Cheque returned unpaid by the bank (insufficient funds).", principal);
    }

    log.push(
      `Fees (${school.schoolId}): ${ob.receipts.length} opening receipts, ${counter.length - online} counter receipts, ${online} online; ${owing} families still owe Term II (${partials} part-paid${bounced ? ", 1 bounced cheque" : ""}).`,
    );
  }
  return log;
}
