/**
 * What the portal and Stud-AI say to each other (contract 3).
 *
 * The portal pipes a request into `python -m stud_ai.batch` on the same
 * server and reads the answer back (lib/studai/runner.ts). Only numbers go
 * in, under the portal's own IDs: no names, SR numbers, gender, age or
 * anything else about the child. See docs/STUD-AI.md and the Stud-AI README
 * ("For the Campus Portal").
 *
 * Pure types and checks (no database, no "server-only"), so the unit tests
 * can use them.
 */
import { z } from "zod";

export const CONTRACT = 3;

/** One subject for one student: test scores so far as percentages (oldest first), attendance % and homework %. */
export type SubjectInput = {
  /** The portal's subject ID. */
  key: string;
  /** The subject's name, as the school calls it ("Mathematics", "Social Science"). */
  name: string;
  tests: number[];
  attendance: number | null;
  homework: number | null;
};

export type StudentInput = {
  /** The portal's student ID (never the name). */
  ref: string;
  subjects: SubjectInput[];
};

export type BatchRequest = { contract: typeof CONTRACT; students: StudentInput[] };

/** Stud-AI's sentence for an estimate (stud_ai/predict.py SENTENCE). */
const SENTENCE = /^Estimated risk of not passing the next .{1,150} examination: (\d{1,2})%$/;

/** One of the main reasons behind an estimate, in words (never a model weight). */
const reason = z.object({
  key: z.string().min(1).max(100),
  words: z.string().min(1).max(200),
  value: z.string().max(200),
  effect: z.enum(["raises", "lowers"]),
  sentence: z.string().min(1).max(400),
}).strict();

/**
 * One subject's estimate: the risk of not passing the next examination as a
 * whole percent, Stud-AI's sentence, the main reasons and the inputs it had
 * to assume. A subject Stud-AI wasn't trained on gets no estimate (percent
 * null, no reasons): teachers see "Not enough data as of now".
 */
const result = z.object({
  ref: z.string().min(1).max(100),
  key: z.string().min(1).max(100),
  subject: z.string().min(1).max(100),
  percent: z.number().int().min(1).max(99).nullable(),
  text: z.string().min(1).max(300),
  reasons: z.array(reason).max(5),
  assumed: z.array(z.string().min(1).max(200)).max(10),
  known_subject: z.boolean(),
  tests_used: z.number().int().min(1).max(5),
}).strict()
  .refine((r) => r.known_subject === (r.percent !== null), "An estimate must have a percentage, and a subject Stud-AI wasn't trained on must not.")
  .refine((r) => r.known_subject || (!r.reasons.length && !r.assumed.length), "A subject Stud-AI wasn't trained on has no reasons.")
  // The sentence teachers read must say the same percentage as the figure beside it.
  .refine(
    (r) => (r.known_subject ? SENTENCE.exec(r.text)?.[1] === String(r.percent) : r.text.startsWith("Not enough data as of now")),
    "The sentence must match the estimate.",
  );

const model = z.object({
  version: z.string().nullable(),
  created: z.string().nullable(),
  trees: z.number().int().nullable(),
  subjects_trained_on: z.array(z.string()),
  file_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  card_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});

const response = z.object({
  contract: z.literal(CONTRACT),
  model,
  results: z.array(result),
  skipped: z.array(z.object({ ref: z.string(), key: z.string(), reason: z.string() })),
  errors: z.array(z.object({ ref: z.string(), key: z.string(), error: z.string() })),
});

export type BatchResult = z.infer<typeof result>;
export type EstimateReason = z.infer<typeof reason>;
export type ModelInfo = z.infer<typeof model>;
export type BatchResponse = Omit<z.infer<typeof response>, "results"> & { results: BatchResult[] };

/** Check Stud-AI's answer has the agreed shape; throws an Error saying what is wrong. */
export function parseResponse(raw: unknown): BatchResponse {
  const r = response.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new Error(`Stud-AI's answer isn't in the expected shape (${first ? `${first.path.join(".") || "answer"}: ${first.message}` : "unknown problem"}).`);
  }
  return r.data as BatchResponse;
}
