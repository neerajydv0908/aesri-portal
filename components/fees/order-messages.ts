/**
 * What families read when a payment can't go ahead — online, or a cash
 * payment they record — in English and Hindi. The services raise OrderError
 * or ClaimError with a code; pages pick the words.
 */
import { rupees } from "@/lib/services/fees";
import type { OrderErrorCode } from "@/lib/services/payments";
import type { ClaimErrorCode } from "@/lib/services/cash-claims";

type T = (en: string, hi: string) => string;
type Limits = { min: number; max: number } | undefined;

/** "Pay at least ₹1,000 of tuition (any amount up to ₹18,000)." */
function tooSmall(t: T, limits: Limits, verb: { en: string; hi: string }): string {
  if (!limits) return t("The tuition amount is too small.", "ट्यूशन फ़ीस की राशि बहुत कम है।");
  if (limits.min >= limits.max) {
    return t(
      `${rupees(limits.max)} of tuition is left for this session: ${verb.en} that amount.`,
      `इस सत्र की ${rupees(limits.max)} ट्यूशन फ़ीस बाकी है: यही राशि ${verb.hi}।`,
    );
  }
  return t(
    `${verb.en[0].toUpperCase()}${verb.en.slice(1)} at least ${rupees(limits.min)} of tuition (any amount up to ${rupees(limits.max)}).`,
    `ट्यूशन फ़ीस कम से कम ${rupees(limits.min)} ${verb.hi} (${rupees(limits.max)} तक कोई भी राशि)।`,
  );
}

function tooLarge(t: T, limits: Limits): string {
  if (!limits) return t("That is more tuition than is left to pay this session.", "यह इस सत्र की बची हुई ट्यूशन फ़ीस से अधिक है।");
  return t(
    `Only ${rupees(limits.max)} of tuition is left to pay this session. Enter that amount or less.`,
    `इस सत्र की केवल ${rupees(limits.max)} ट्यूशन फ़ीस बाकी है। इतनी या इससे कम राशि लिखें।`,
  );
}

export function orderErrorText(code: OrderErrorCode, t: T, limits?: Limits): string {
  switch (code) {
    case "unavailable":
      return t("Online payment is not available yet. Please pay at the school office.", "ऑनलाइन भुगतान अभी उपलब्ध नहीं है। कृपया फ़ीस विद्यालय कार्यालय में जमा करें।");
    case "no_lines":
      return t("Tick the admission fee, or write how much tuition to pay.", "प्रवेश शुल्क चुनें, या लिखें कि कितनी ट्यूशन फ़ीस जमा करनी है।");
    case "not_due":
      return t(
        "Some of the chosen fees are already paid or no longer due. The page has been updated — please choose again.",
        "चुनी गई कुछ फ़ीस पहले ही जमा हो चुकी है या अब देय नहीं है। पृष्ठ अपडेट कर दिया गया है — कृपया फिर से चुनें।",
      );
    case "too_small":
      return t("This amount is too small to pay online. Please pay at the school office.", "यह राशि ऑनलाइन भुगतान के लिए बहुत कम है। कृपया विद्यालय कार्यालय में जमा करें।");
    case "amount_small":
      return tooSmall(t, limits, { en: "pay", hi: "जमा करें" });
    case "amount_large":
      return tooLarge(t, limits);
    case "open_order":
      return t(
        "You already started an online payment. Continue that payment (shown above), or cancel it first.",
        "आपने एक ऑनलाइन भुगतान पहले ही शुरू किया है। उसे पूरा करें (ऊपर दिखाया गया है) या पहले उसे रद्द करें।",
      );
    case "changed":
      return t(
        "The fees have changed since you started this payment. Cancel it and start again.",
        "आपके यह भुगतान शुरू करने के बाद फ़ीस बदल गई है। इसे रद्द करें और फिर से शुरू करें।",
      );
    case "gateway":
      return t("The payment service could not be reached. Please try again in a few minutes.", "भुगतान सेवा से संपर्क नहीं हो सका। कृपया कुछ मिनट बाद फिर से प्रयास करें।");
    case "expired":
      return t(
        "This payment timed out after 30 minutes. Go back to Fees and start again.",
        "30 मिनट में भुगतान पूरा न होने से यह समाप्त हो गया। फ़ीस पृष्ठ पर जाकर फिर से शुरू करें।",
      );
    case "closed":
      return t(
        "This payment was not completed. No money was taken. Go back to Fees to try again.",
        "यह भुगतान पूरा नहीं हुआ। कोई पैसा नहीं कटा। फिर से प्रयास करने के लिए फ़ीस पृष्ठ पर जाएँ।",
      );
    case "signature":
      return t(
        "The payment could not be verified, so no receipt was issued. If money was taken from your account, it will be confirmed or refunded automatically.",
        "भुगतान की पुष्टि नहीं हो सकी, इसलिए रसीद नहीं बनी। यदि आपके खाते से पैसा कटा है, तो उसकी पुष्टि या वापसी अपने आप हो जाएगी।",
      );
    case "mismatch":
      return t(
        "The amount paid did not match the fees chosen, so no receipt was issued. The school office has been alerted and will contact you.",
        "जमा राशि चुनी गई फ़ीस से मेल नहीं खाती, इसलिए रसीद नहीं बनी। विद्यालय कार्यालय को सूचना दे दी गई है, वे आपसे संपर्क करेंगे।",
      );
    case "pending":
      return t(
        "Your payment is being confirmed with the bank. It will appear on the Fees page within a few minutes — please don't pay again.",
        "आपके भुगतान की बैंक से पुष्टि हो रही है। कुछ ही मिनटों में यह फ़ीस पृष्ठ पर दिखेगा — कृपया दोबारा भुगतान न करें।",
      );
    default:
      return t("Payment not found.", "भुगतान नहीं मिला।");
  }
}

/** A cash payment the family records (or removes) that can't be saved. */
export function claimErrorText(code: ClaimErrorCode, t: T, limits?: Limits): string {
  switch (code) {
    case "nothing":
      return t("Tick the admission fee, or write how much tuition you paid.", "प्रवेश शुल्क चुनें, या लिखें कि आपने कितनी ट्यूशन फ़ीस जमा की।");
    case "tuition_small":
      return tooSmall(t, limits, { en: "record", hi: "दर्ज करें" });
    case "tuition_large":
      return tooLarge(t, limits);
    case "admission_gone":
    case "tuition_gone":
      return t(
        "Some of these fees are already paid, or a payment you recorded for them is waiting for approval. The page has been updated — please check again.",
        "इनमें से कुछ फ़ीस पहले ही जमा हो चुकी है, या उसका दर्ज किया गया भुगतान स्वीकृति की प्रतीक्षा में है। पृष्ठ अपडेट कर दिया गया है — कृपया फिर से देखें।",
      );
    case "date":
      return t("Enter the date you paid: today or an earlier day of this session.", "भुगतान की तारीख लिखें: आज की या इस सत्र की कोई पिछली तारीख।");
    case "too_many":
      return t(
        "Three recorded payments are already waiting for the school's approval. Please wait until the school has looked at them.",
        "तीन दर्ज भुगतान पहले से विद्यालय की स्वीकृति की प्रतीक्षा में हैं। कृपया विद्यालय के उन्हें देखने तक प्रतीक्षा करें।",
      );
    case "open_order":
      return t(
        "An online payment is in progress. Finish it or cancel it first (shown above).",
        "एक ऑनलाइन भुगतान चल रहा है। पहले उसे पूरा करें या रद्द करें (ऊपर दिखाया गया है)।",
      );
    case "decided":
      return t("The school has already looked at this payment, so it can't be removed.", "विद्यालय इस भुगतान को पहले ही देख चुका है, इसलिए इसे हटाया नहीं जा सकता।");
    default:
      return t("That recorded payment was not found.", "यह दर्ज भुगतान नहीं मिला।");
  }
}
