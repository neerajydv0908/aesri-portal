/**
 * The portal's privacy notice — public (no sign-in needed), in English or
 * Hindi. Families agree to it when they activate their account. It is a
 * draft for AESRI to approve: keep the version and date below up to date.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { AesriEmblem } from "@/components/brand/emblems";
import { LanguageSwitch } from "@/components/shell/language-switch";
import { tr, type Lang } from "@/lib/i18n";
import { getLang } from "@/lib/i18n/server";
import { formatDate } from "@/lib/dates";
import { smsCompanyName } from "@/lib/sms/providers";
import { translationOn, translationProviderLabel } from "@/lib/translate";

const NOTICE_VERSION = "0.8";
const NOTICE_DATE = "2026-10-04";
const OFFICE_PHONE = "+91 75973 82016";
const OFFICE_EMAIL = "deepakudairamsar@gmail.com";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getLang()) === "hi" ? "गोपनीयता सूचना" : "Privacy notice" };
}

type Section = { en: string; hi: string; paras?: { en: string; hi: string }[]; bullets?: { en: string; hi: string }[] };

const SECTIONS: Section[] = [
  {
    en: "Who is responsible",
    hi: "ज़िम्मेदार कौन है",
    paras: [
      {
        en: "The Campus Portal is run by Aryavart Educational and Social Research Institute (AESRI), a registered society (Reg. No. 65/BKN/2012-13), for Aryavart Public School, Palana and Aadharshila Public School, Udairamsar. AESRI decides how the personal information in the portal is used.",
        hi: "कैंपस पोर्टल आर्यवर्त शैक्षिक एवं सामाजिक अनुसंधान संस्थान (एईएसआरआई), एक पंजीकृत संस्था (पंजीयन सं. 65/BKN/2012-13), आर्यवर्त पब्लिक स्कूल, पलाना और आधारशिला पब्लिक स्कूल, उदयरामसर के लिए चलाता है। पोर्टल की व्यक्तिगत जानकारी का उपयोग कैसे हो, यह एईएसआरआई तय करता है।",
      },
    ],
  },
  {
    en: "What the portal holds",
    hi: "पोर्टल में क्या जानकारी रहती है",
    bullets: [
      {
        en: "The student's school record: name, SR number, class, section and roll number, date of birth, gender, admission date, parents' or guardian's names, mobile numbers, village or address, and whether the child was admitted on an RTE seat.",
        hi: "विद्यार्थी का विद्यालय रिकॉर्ड: नाम, एस.आर. क्रमांक, कक्षा, वर्ग और रोल नंबर, जन्म तिथि, लिंग, प्रवेश तिथि, माता-पिता या अभिभावक के नाम, मोबाइल नंबर, गाँव या पता, और क्या प्रवेश RTE सीट पर हुआ।",
      },
      {
        en: "School life: attendance, homework and whether it was done, marks and results, notices, and teachers' remarks (families see only the remarks the teacher shares with them).",
        hi: "विद्यालय की गतिविधियाँ: उपस्थिति, गृहकार्य और क्या वह किया गया, अंक और परिणाम, सूचनाएँ, और शिक्षकों की टिप्पणियाँ (परिवार केवल वही टिप्पणियाँ देखते हैं जो शिक्षक उनसे साझा करते हैं)।",
      },
      {
        en: "Fees: what is due, payments and receipts, and cash payments a family records on the portal (the amount, the day and, if they write it, who received it) with the school's approval or reason for declining. Online payments are handled by the payment company (Razorpay): card, UPI and bank details go to them, never to the portal, which receives only the payment reference and amount.",
        hi: "फ़ीस: देय राशि, भुगतान और रसीदें, और परिवार द्वारा पोर्टल पर दर्ज किए गए नकद भुगतान (राशि, तारीख़ और, यदि लिखें तो, पैसे किसने लिए) तथा उन पर विद्यालय की स्वीकृति या अस्वीकार करने का कारण। ऑनलाइन भुगतान भुगतान कंपनी (Razorpay) संभालती है: कार्ड, यूपीआई और बैंक विवरण सीधे उन्हें जाते हैं, पोर्टल को कभी नहीं; पोर्टल को केवल भुगतान का संदर्भ और राशि मिलती है।",
      },
      {
        en: "Staff: name, employee number, designation, mobile, email, and the classes and subjects they teach.",
        hi: "स्टाफ़: नाम, कर्मचारी क्रमांक, पद, मोबाइल, ईमेल, और वे कौन-सी कक्षाएँ व विषय पढ़ाते हैं।",
      },
      {
        en: "Sign-in: the login ID, the password in scrambled (hashed) form, for administrators an encrypted authenticator key and the browsers they chose to trust (a short name such as “Chrome on Windows” and the dates, removed once the 30 days are over), sign-in times, and an activity log of changes (who did what, when, and from which internet address).",
        hi: "साइन इन: लॉगिन आईडी, पासवर्ड का बदला हुआ (हैश) रूप, प्रशासकों के लिए कूटबद्ध ऑथेंटिकेटर कुंजी और वे ब्राउज़र जिन पर उन्होंने भरोसा करना चुना (“Chrome on Windows” जैसा छोटा नाम और तारीख़ें, जो 30 दिन पूरे होने पर हटा दी जाती हैं), साइन इन का समय, और बदलावों का गतिविधि-लॉग (किसने, क्या, कब और किस इंटरनेट पते से किया)।",
      },
      {
        en: "Nothing else. The portal does not hold Aadhaar numbers, caste, bank account details, health information or photographs.",
        hi: "इसके अलावा कुछ नहीं। पोर्टल में आधार नंबर, जाति, बैंक खाते का विवरण, स्वास्थ्य संबंधी जानकारी या फ़ोटो नहीं रखे जाते।",
      },
    ],
  },
  {
    en: "Why it is used",
    hi: "इसका उपयोग क्यों होता है",
    paras: [
      {
        en: "Only to run the schools: to keep attendance and results and share them with the family, to set and check homework, to collect fees and issue receipts, to send notices, to help teachers notice early which students may need support, and to keep the records safe. It is never sold, never used for advertising, and never used to build profiles of children for anyone outside the school.",
        hi: "केवल विद्यालय चलाने के लिए: उपस्थिति और परिणाम रखना और परिवार को बताना, गृहकार्य देना और जाँचना, फ़ीस लेना और रसीद देना, सूचनाएँ भेजना, शिक्षकों को समय रहते यह पहचानने में मदद करना कि किन विद्यार्थियों को सहायता की ज़रूरत हो सकती है, और रिकॉर्ड सुरक्षित रखना। यह जानकारी न कभी बेची जाती है, न विज्ञापन के लिए उपयोग होती है, और न ही विद्यालय के बाहर किसी के लिए बच्चों की प्रोफ़ाइल बनाने में।",
      },
    ],
  },
  {
    en: "Who can see it",
    hi: "इसे कौन देख सकता है",
    bullets: [
      { en: "The family using the student's account — their own child's information only.", hi: "विद्यार्थी का खाता उपयोग करने वाला परिवार — केवल अपने बच्चे की जानकारी।" },
      {
        en: "Teachers — only for the classes and subjects they teach; a class teacher sees more about their own class.",
        hi: "शिक्षक — केवल उन कक्षाओं और विषयों के लिए जिन्हें वे पढ़ाते हैं; कक्षाध्यापक अपनी कक्षा के बारे में अधिक देख सकते हैं।",
      },
      { en: "The principal and the school office — their own school. The accountant — fees and basic student details.", hi: "प्रधानाचार्य और विद्यालय कार्यालय — अपना विद्यालय। लेखाकार — फ़ीस और विद्यार्थी का मूल विवरण।" },
      { en: "AESRI administrators — both schools, to supervise and to help.", hi: "एईएसआरआई प्रशासक — दोनों विद्यालय, देखरेख और सहायता के लिए।" },
      {
        en: "Companies that host the portal, process online payments and send text messages for AESRI, only to provide that service and under contract.",
        hi: "वे कंपनियाँ जो एईएसआरआई के लिए पोर्टल चलाती हैं, ऑनलाइन भुगतान संभालती हैं और एसएमएस भेजती हैं — केवल वह सेवा देने के लिए और अनुबंध के तहत।",
      },
    ],
  },
  {
    en: "How long it is kept",
    hi: "जानकारी कितने समय रखी जाती है",
    bullets: [
      {
        en: "School records (admission details, attendance, results, fee receipts) are kept for as long as the law requires schools to keep them.",
        hi: "विद्यालय रिकॉर्ड (प्रवेश विवरण, उपस्थिति, परिणाम, फ़ीस रसीदें) उतने समय रखे जाते हैं जितना क़ानून विद्यालयों से अपेक्षा करता है।",
      },
      { en: "When a student leaves, the family's sign-in is turned off.", hi: "विद्यार्थी के विद्यालय छोड़ने पर परिवार का साइन इन बंद कर दिया जाता है।" },
      {
        en: "The activity log is kept for at least 180 days, as Indian cyber-security rules require.",
        hi: "गतिविधि-लॉग कम से कम 180 दिन रखा जाता है, जैसा भारत के साइबर-सुरक्षा नियम कहते हैं।",
      },
      {
        en: "Stud-AI's estimates for teachers (see below) are kept only for the current school year, and are replaced whenever a student's marks, homework or attendance change.",
        hi: "शिक्षकों के लिए Stud-AI के अनुमान (नीचे देखें) केवल चालू शैक्षणिक वर्ष के लिए रखे जाते हैं, और जब भी विद्यार्थी के अंक, गृहकार्य या उपस्थिति बदलती है, नए अनुमान पुराने की जगह ले लेते हैं।",
      },
      {
        en: "Excel files uploaded to add students and staff are not kept: once an import is finished or cancelled, only a count of what changed remains.",
        hi: "विद्यार्थी और स्टाफ़ जोड़ने के लिए अपलोड की गई एक्सेल फ़ाइलें नहीं रखी जातीं: आयात पूरा या रद्द होने के बाद केवल बदलावों की गिनती बचती है।",
      },
    ],
  },
  {
    en: "How it is protected",
    hi: "जानकारी कैसे सुरक्षित रखी जाती है",
    paras: [
      {
        en: "The portal works only over a secure (HTTPS) connection. Passwords are stored scrambled; first sign-in and forgotten passwords use one-time codes printed by the school; administrators also use a second step (an authenticator app). Each person sees only what their role needs, and every change is recorded.",
        hi: "पोर्टल केवल सुरक्षित (HTTPS) कनेक्शन पर चलता है। पासवर्ड बदले हुए रूप में रखे जाते हैं; पहली बार साइन इन और भूले पासवर्ड के लिए विद्यालय द्वारा छपे एक-बार वाले कोड उपयोग होते हैं; प्रशासक एक दूसरा चरण (ऑथेंटिकेटर ऐप) भी उपयोग करते हैं। हर व्यक्ति केवल वही देखता है जो उसकी भूमिका के लिए ज़रूरी है, और हर बदलाव दर्ज होता है।",
      },
    ],
  },
  {
    en: "Text messages",
    hi: "एसएमएस संदेश",
    paras: [
      {
        en: "The school also sends short text messages (SMS) to the parent's mobile number on the student's record (and, if the school chooses, to the second mobile number): when the child is marked present, absent, late or on leave; when a teacher shares a remark (the message only says there is a new note to read on the portal, never what it says); when a notice is published for the family; a daily homework summary; when results are published; when a fee payment is received or a receipt cancelled; and when the school declines a cash payment the family recorded on the portal. Staff get notices meant for staff.",
        hi: "विद्यालय विद्यार्थी के रिकॉर्ड में दर्ज माता-पिता के मोबाइल नंबर पर (और यदि विद्यालय चुने, तो दूसरे मोबाइल नंबर पर भी) छोटे एसएमएस संदेश भेजता है: जब बच्चे की उपस्थिति, अनुपस्थिति, देर से आना या अवकाश दर्ज हो; जब शिक्षक कोई टिप्पणी साझा करें (संदेश में केवल इतना होता है कि पोर्टल पर नई टिप्पणी है, टिप्पणी की बात कभी नहीं); जब परिवार के लिए कोई सूचना जारी हो; गृहकार्य का दैनिक सारांश; जब परिणाम घोषित हों; जब फ़ीस का भुगतान मिले या कोई रसीद रद्द हो; और जब विद्यालय परिवार द्वारा पोर्टल पर दर्ज किया गया नकद भुगतान अस्वीकार करे। स्टाफ़ को स्टाफ़ के लिए जारी सूचनाएँ मिलती हैं।",
      },
      {
        en: "A message contains the school's name, the child's name and class, and the news itself (for example the date and the attendance mark, or the amount and receipt number). It is sent through an SMS company registered with the telecom regulator (TRAI), under contract with AESRI, which receives only the mobile number and the message. The portal keeps each message for 180 days; after that only a count remains.",
        hi: "संदेश में विद्यालय का नाम, बच्चे का नाम और कक्षा, और सूचना होती है (जैसे तारीख़ और उपस्थिति, या राशि और रसीद नंबर)। यह दूरसंचार नियामक (ट्राई) में पंजीकृत एक एसएमएस कंपनी के माध्यम से, एईएसआरआई के साथ अनुबंध के तहत भेजा जाता है, जिसे केवल मोबाइल नंबर और संदेश मिलता है। पोर्टल हर संदेश 180 दिन रखता है; उसके बाद केवल गिनती बचती है।",
      },
      {
        en: "To stop text messages, or to change the number they go to, tell the school office. You will still see everything in the portal.",
        hi: "एसएमएस संदेश बंद करवाने या उनका नंबर बदलवाने के लिए विद्यालय कार्यालय को बताएँ। पोर्टल में आपको फिर भी सब कुछ दिखता रहेगा।",
      },
    ],
  },
  {
    en: "Hindi translation",
    hi: "हिंदी अनुवाद",
    paras: [
      {
        en: "Families who choose Hindi see what teachers and the office wrote in English — homework, notices, remarks shared with the family, report-card remarks and the school's notes on fees — translated into Hindi automatically, marked as a translation, with the original a tap away. For this, only that text is sent to a translation service under contract with AESRI; it can include what a teacher wrote about a child, but the portal adds nothing to it (no names, numbers or records). The service translates it and does not keep it; it may do so in a data centre outside India.",
        hi: "जो परिवार हिंदी चुनते हैं, उन्हें शिक्षकों और कार्यालय द्वारा अंग्रेज़ी में लिखी बातें — गृहकार्य, सूचनाएँ, परिवार से साझा की गई टिप्पणियाँ, प्रगति पत्र की टिप्पणी और फ़ीस पर विद्यालय की टिप्पणी — अपने-आप हिंदी में अनुवाद होकर दिखती हैं, अनुवाद के रूप में चिह्नित, और मूल अंग्रेज़ी एक टैप पर। इसके लिए केवल वही लिखी हुई बात एईएसआरआई के साथ अनुबंधित अनुवाद सेवा को भेजी जाती है; इसमें वह बात हो सकती है जो शिक्षक ने किसी बच्चे के बारे में लिखी, पर पोर्टल उसमें अपनी ओर से कुछ नहीं जोड़ता (न नाम, न अंक, न रिकॉर्ड)। सेवा अनुवाद करके उसे अपने पास नहीं रखती; यह अनुवाद भारत के बाहर किसी डेटा केंद्र में भी हो सकता है।",
      },
      {
        en: "The portal keeps each translation, so the same text isn't sent twice, and deletes translations nobody has read for 180 days.",
        hi: "पोर्टल हर अनुवाद रखता है, ताकि वही बात दोबारा न भेजनी पड़े, और जिन अनुवादों को 180 दिन तक किसी ने नहीं पढ़ा, उन्हें हटा देता है।",
      },
    ],
  },
  {
    en: "Estimates for teachers (Stud-AI)",
    hi: "शिक्षकों के लिए अनुमान (Stud-AI)",
    paras: [
      {
        en: "To help teachers notice early when a student may need support, the portal uses Stud-AI: a program that, for each subject it has learned, estimates the risk that the student will not pass the next examination, as a percentage, with the main reasons for the estimate (for example, falling test marks or homework not done). For subjects it has not learned yet, it shows “not enough data as of now” instead of an estimate. It learned these patterns from past examination results.",
        hi: "शिक्षकों को समय रहते यह पहचानने में मदद के लिए कि किस विद्यार्थी को सहायता की ज़रूरत हो सकती है, पोर्टल Stud-AI का उपयोग करता है: यह प्रोग्राम जिन विषयों पर इसे प्रशिक्षण मिला है, उनमें हर विषय के लिए अनुमान लगाता है कि विद्यार्थी के अगली परीक्षा में उत्तीर्ण न होने की कितनी आशंका है — प्रतिशत में, और इस अनुमान के मुख्य कारणों के साथ (जैसे परीक्षा के घटते अंक या गृहकार्य न करना)। जिन विषयों पर इसे अभी प्रशिक्षण नहीं मिला है, उनके लिए अनुमान के बजाय “अभी पर्याप्त जानकारी नहीं” दिखाया जाता है। इसने ये पैटर्न पिछले परीक्षा परिणामों से सीखे हैं।",
      },
      {
        en: "It uses only numbers from the school's records: each subject's test marks this session as percentages, how much homework was done in each subject, and the attendance percentage. It never uses names, gender, age, parents' details, fees, caste, religion, health or what teachers wrote in remarks. Stud-AI runs on the school's own server: nothing is sent to an AI company or anywhere outside the school.",
        hi: "यह केवल विद्यालय के रिकॉर्ड की संख्याओं का उपयोग करता है: इस सत्र में हर विषय की परीक्षाओं के अंक प्रतिशत में, हर विषय में कितना गृहकार्य किया गया, और उपस्थिति का प्रतिशत। यह कभी नाम, लिंग, आयु, माता-पिता का विवरण, फ़ीस, जाति, धर्म, स्वास्थ्य या शिक्षकों द्वारा लिखी गई टिप्पणियों का उपयोग नहीं करता। Stud-AI विद्यालय के अपने सर्वर पर चलता है: किसी एआई कंपनी को या विद्यालय के बाहर कहीं भी कुछ नहीं भेजा जाता।",
      },
      {
        en: "Only the class teacher and the school's administrators see the estimates, in the teachers' “Needs support” view, where a student is shown in red when Stud-AI's estimate is 50% or more in a subject, or when low attendance comes with several concerns, and as needing a teacher’s review when the student’s most recent mark in a subject is below the pass mark or they missed that exam. They are a prompt to offer help early, not a judgement of the child, and they can be wrong. They are never shown to families or students, and never used for marks, promotion, admission or any other decision about a child: teachers decide what to do.",
        hi: "अनुमान केवल कक्षाध्यापक और विद्यालय के प्रशासक, शिक्षकों के “सहायता की ज़रूरत” वाले दृश्य में देखते हैं, जहाँ किसी विषय में Stud-AI का अनुमान 50% या उससे अधिक होने पर, या कम उपस्थिति के साथ कई चिंताएँ दर्ज होने पर, विद्यार्थी लाल रंग में दिखता है; और किसी विषय में विद्यार्थी के सबसे हाल के अंक उत्तीर्णांक से कम होने पर या उस परीक्षा में अनुपस्थित रहने पर, “शिक्षक की समीक्षा ज़रूरी” दिखता है। ये समय रहते मदद करने का संकेत हैं, बच्चे के बारे में कोई निर्णय नहीं, और ये ग़लत भी हो सकते हैं। ये परिवारों या विद्यार्थियों को कभी नहीं दिखाए जाते, और अंक, अगली कक्षा में भेजने, प्रवेश या बच्चे के बारे में किसी अन्य निर्णय के लिए कभी उपयोग नहीं होते: क्या करना है, यह शिक्षक तय करते हैं।",
      },
    ],
  },
  {
    en: "Cookies",
    hi: "कुकीज़",
    paras: [
      {
        en: "Only three, all needed: one keeps you signed in, one remembers English or Hindi, and one remembers that this phone or computer has signed in to your account before, so that if someone elsewhere keeps guessing your password you can still sign in here. Administrators may get two more: one that lets a browser skip the authenticator code for 30 days when they tick “Trust this browser” (the password is still needed), and, for AESRI administrators, one that remembers which school they are working on. None of them holds a password or personal details. There are no advertising or tracking cookies and no third-party analytics.",
        hi: "केवल तीन, तीनों ज़रूरी: एक आपको साइन इन रखती है, एक अंग्रेज़ी या हिंदी याद रखती है, और एक यह याद रखती है कि इस फ़ोन या कंप्यूटर से आपके खाते में पहले साइन इन हो चुका है, ताकि अगर कोई और कहीं से आपका पासवर्ड अनुमान लगाने की कोशिश करता रहे, तब भी आप यहाँ साइन इन कर सकें। प्रशासकों के लिए दो और हो सकती हैं: एक, जब वे “Trust this browser” पर टिक करते हैं, जिससे वह ब्राउज़र 30 दिनों तक ऑथेंटिकेटर कोड नहीं माँगता (पासवर्ड फिर भी ज़रूरी है), और एईएसआरआई प्रशासकों के लिए एक, जो याद रखती है कि वे किस विद्यालय का काम देख रहे हैं। इनमें से किसी में न कोई पासवर्ड होता है, न कोई निजी जानकारी। कोई विज्ञापन या ट्रैकिंग कुकी नहीं है और कोई बाहरी विश्लेषण (एनालिटिक्स) नहीं।",
      },
    ],
  },
  {
    en: "Children's information and consent",
    hi: "बच्चों की जानकारी और सहमति",
    paras: [
      {
        en: "A student's account is for the parent or guardian to use, with their child if they wish. By activating the account, the parent or guardian agrees to this notice on the child's behalf. You can ask the school office to turn the account off at any time; the school still keeps the school record it must keep by law.",
        hi: "विद्यार्थी का खाता माता-पिता या अभिभावक के उपयोग के लिए है, चाहें तो बच्चे के साथ। खाता सक्रिय करके माता-पिता या अभिभावक बच्चे की ओर से इस सूचना से सहमति देते हैं। आप कभी भी विद्यालय कार्यालय से खाता बंद करवा सकते हैं; विद्यालय फिर भी वह रिकॉर्ड रखेगा जो क़ानूनन रखना ज़रूरी है।",
      },
    ],
  },
  {
    en: "Your rights and questions",
    hi: "आपके अधिकार और प्रश्न",
    bullets: [
      { en: "See your child's information — it is in the portal.", hi: "अपने बच्चे की जानकारी देखना — वह पोर्टल में है।" },
      { en: "Ask the school office to correct anything that is wrong.", hi: "जो कुछ ग़लत है, उसे ठीक करने के लिए विद्यालय कार्यालय से कहना।" },
      {
        en: "Ask a question or make a complaint about your information to the school office or to AESRI. If you are not satisfied with the answer, you may approach the Data Protection Board of India.",
        hi: "अपनी जानकारी के बारे में प्रश्न या शिकायत विद्यालय कार्यालय या एईएसआरआई से करना। उत्तर से संतुष्ट न हों, तो आप भारत के डेटा संरक्षण बोर्ड से संपर्क कर सकते हैं।",
      },
    ],
  },
];

export default async function PrivacyPage() {
  const lang: Lang = await getLang();
  const t = tr(lang);
  const smsCompany = smsCompanyName();
  return (
    <div className="min-h-dvh bg-cream-100">
      <header className="border-b border-forest-900/10 bg-cream-50/70">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Link href="/login" className="flex items-center gap-2.5 rounded-lg">
            <AesriEmblem className="h-9 w-9 text-forest-700" title="" />
            <span className="font-display text-lg text-forest-900">{t("AESRI Campus Portal", "एईएसआरआई कैंपस पोर्टल")}</span>
          </Link>
          <LanguageSwitch lang={lang} />
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-3xl px-4 py-10 outline-none sm:px-6">
        <p className="eyebrow">{t("Campus Portal", "कैंपस पोर्टल")}</p>
        <h1 className="mt-2 text-[clamp(2rem,4vw,2.6rem)] text-forest-900">{t("Privacy notice", "गोपनीयता सूचना")}</h1>
        <p className="mt-3 text-muted">
          {t(
            `Version ${NOTICE_VERSION}, ${formatDate(NOTICE_DATE, "en")} — draft for AESRI's approval. It explains what the portal holds about students, families and staff, why, and who can see it.`,
            `संस्करण ${NOTICE_VERSION}, ${formatDate(NOTICE_DATE, "hi")} — एईएसआरआई की स्वीकृति हेतु प्रारूप। इसमें बताया गया है कि पोर्टल में विद्यार्थियों, परिवारों और स्टाफ़ के बारे में क्या जानकारी है, क्यों है और उसे कौन देख सकता है।`,
          )}
        </p>
        <div className="mt-8 grid gap-6">
          {SECTIONS.map((s) => (
            <section key={s.en} className="card p-6 sm:p-7">
              <h2 className="font-display text-[1.35rem] text-forest-900">{t(s.en, s.hi)}</h2>
              {s.paras?.map((p) => (
                <p key={p.en} className="mt-3 text-[1rem] leading-relaxed text-forest-900/90">
                  {t(p.en, p.hi)}
                </p>
              ))}
              {s.bullets ? (
                <ul className="mt-3 grid list-disc gap-2 pl-5 text-[1rem] leading-relaxed text-forest-900/90">
                  {s.bullets.map((b) => (
                    <li key={b.en}>{t(b.en, b.hi)}</li>
                  ))}
                </ul>
              ) : null}
              {s.en === "Hindi translation" ? (
                <p className="mt-3 text-[1rem] leading-relaxed text-forest-900/90">
                  {translationOn()
                    ? t(`The translation service is ${translationProviderLabel()}.`, `अनुवाद सेवा: ${translationProviderLabel()}।`)
                    : t(
                        "Automatic translation is not switched on yet, so nothing is sent; the translation service will be named here before it starts.",
                        "अपने-आप अनुवाद अभी चालू नहीं है, इसलिए कुछ नहीं भेजा जाता; शुरू होने से पहले अनुवाद सेवा का नाम यहाँ दिया जाएगा।",
                      )}
                </p>
              ) : null}
              {s.en === "Text messages" ? (
                <p className="mt-3 text-[1rem] leading-relaxed text-forest-900/90">
                  {smsCompany
                    ? t(`The SMS company is ${smsCompany}.`, `एसएमएस कंपनी: ${smsCompany}।`)
                    : t("Text messages are not being sent yet; the SMS company will be named here before they start.", "अभी एसएमएस संदेश नहीं भेजे जा रहे हैं; शुरू होने से पहले एसएमएस कंपनी का नाम यहाँ दिया जाएगा।")}
                </p>
              ) : null}
            </section>
          ))}
          <section className="card p-6 sm:p-7">
            <h2 className="font-display text-[1.35rem] text-forest-900">{t("Contact", "संपर्क")}</h2>
            <p className="mt-3 text-[1rem] leading-relaxed text-forest-900/90">
              {t("The school office (both schools and AESRI):", "विद्यालय कार्यालय (दोनों विद्यालय और एईएसआरआई):")}{" "}
              <a href={`tel:${OFFICE_PHONE.replace(/\s+/g, "")}`} className="font-semibold text-forest-800 underline underline-offset-2">
                {OFFICE_PHONE}
              </a>{" "}
              ·{" "}
              <a href={`mailto:${OFFICE_EMAIL}`} className="font-semibold text-forest-800 underline underline-offset-2">
                {OFFICE_EMAIL}
              </a>
            </p>
          </section>
        </div>
        <p className="mt-10">
          <Link href="/login" className="font-semibold text-forest-800 underline-offset-4 hover:underline">
            {t("← Back to sign in", "← साइन इन पर वापस जाएँ")}
          </Link>
        </p>
      </main>
    </div>
  );
}
