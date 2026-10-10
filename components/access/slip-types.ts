/**
 * What a printed sign-in slip shows. Built by the Server Action that issues
 * the codes and returned to the page only in that action's result: the
 * one-time codes are never stored, logged or put in a URL.
 */
export type SlipData = {
  /** Display login ID: Arya7634, AryaE12, aesri.name */
  loginId: string;
  name: string;
  /** "Class V, section A", a designation, or "AESRI administrator". */
  detail: string | null;
  /** XXXX-XXXX */
  code: string;
  /** Last day the code works (YYYY-MM-DD, IST). */
  validUntil: string;
  /** QR code (data: URI of an SVG) that opens /activate?id=<login ID>. Never contains the code. */
  qr: string;
  /** Principal, office admin, accountant or AESRI administrator: sets up an authenticator app after activating. */
  admin: boolean;
  /** The account had a password: this slip replaced it. */
  reset: boolean;
};

export type SlipBatch = {
  org: { name: string; nameHi: string; kind: "school" | "aesri" };
  /** Portal address to type, e.g. "portal.example.org/activate". */
  address: string;
  slips: SlipData[];
};

/** Slips print 8 to an A4 sheet (components/access/slips.tsx). */
export const SLIPS_PER_SHEET = 8;
export const sheetsFor = (slips: number) => Math.ceil(slips / SLIPS_PER_SHEET);

/** Printing for many people at once: everyone waiting in a class, in the school (students or staff), or everyone an Excel import added. */
export type BulkIntent = "section" | "everyone-students" | "everyone-staff" | "import";

/**
 * A print for many people is confirmed first when it is long (more than
 * five sheets) or would cancel slips that still work; the numbers are
 * checked again on the server, so a list that changed is asked about again.
 */
export const LARGE_PRINT = 5 * SLIPS_PER_SHEET;
/** The most slips one print for many people makes (125 sheets); beyond that, print class by class. */
export const MAX_BULK_PRINT = 1000;
export const bulkNeedsConfirm = (total: number, replaced: number) => total > LARGE_PRINT || replaced > 0;
/** What the page showed ("412:37"), sent with the print so the server can tell whether the list changed since. */
export const bulkKey = (total: number, replaced: number) => `${total}:${replaced}`;

/** What the slip-printing actions return in FormState.data. */
export type SlipActionData = {
  batch?: SlipBatch;
  /** Some chosen accounts already have a password: ask before resetting them. */
  confirm?: { resets: number; total: number };
  /** A print for many people needs a confirmation (with the numbers as they are now). */
  bulk?: { intent: BulkIntent; total: number; replaced: number; changed: boolean };
};
