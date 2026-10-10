/**
 * The demo's homework and remarks (fictional, typical of village schools),
 * each with its Hindi beside it. lib/demo/daily.ts writes them into the
 * demo; lib/demo/translations.ts gives families who read Hindi the same
 * texts in Hindi, so the demo shows the translation without a translation
 * service. Pure data: nothing here touches the database.
 */

export type HomeworkIdea = { title: string; titleHi?: string; details?: string; detailsHi?: string };

export const HOMEWORK_IDEAS: Record<string, HomeworkIdea[]> = {
  Hindi: [
    {
      title: "Write 10 lines on “मेरा गाँव”",
      titleHi: "“मेरा गाँव” पर 10 पंक्तियाँ लिखें",
      details: "Neat handwriting in the Hindi copy. Draw a small picture if you like.",
      detailsHi: "हिंदी की कॉपी में साफ़ लिखावट में लिखें। चाहें तो एक छोटा-सा चित्र भी बनाएँ।",
    },
    {
      title: "Learn the poem “वह देश कौन सा है” by heart",
      titleHi: "कविता “वह देश कौन सा है” याद करें",
      details: "We will recite it in class.",
      detailsHi: "हम इसे कक्षा में सुनाएँगे।",
    },
    { title: "Chapter 5: answer questions 1 to 6", titleHi: "अध्याय 5: प्रश्न 1 से 6 के उत्तर लिखें" },
    { title: "Write 15 words with the ‘ऋ’ matra", titleHi: "‘ऋ’ की मात्रा वाले 15 शब्द लिखें" },
    { title: "Letter to your friend about the Teej fair", titleHi: "तीज के मेले के बारे में अपने मित्र को पत्र लिखें" },
  ],
  English: [
    {
      title: "Learn the spellings of lesson 4",
      titleHi: "पाठ 4 के शब्दों की स्पेलिंग (वर्तनी) याद करें",
      details: "Spelling test on the due date.",
      detailsHi: "जमा करने की तारीख को स्पेलिंग टेस्ट होगा।",
    },
    { title: "Write 5 sentences about your family", titleHi: "अपने परिवार के बारे में 5 वाक्य लिखें" },
    {
      title: "Lesson 6: new words and their meanings",
      titleHi: "पाठ 6: नए शब्द और उनके अर्थ",
      details: "Write each word in a sentence.",
      detailsHi: "हर शब्द से एक वाक्य बनाकर लिखें।",
    },
    { title: "Read ‘The Thirsty Crow’ aloud to someone at home", titleHi: "‘The Thirsty Crow’ (प्यासा कौआ) घर पर किसी को ज़ोर से पढ़कर सुनाएँ" },
    { title: "Grammar: fill in the blanks, page 34", titleHi: "व्याकरण: पृष्ठ 34 पर रिक्त स्थान भरें" },
  ],
  Mathematics: [
    { title: "Exercise 4.2, questions 1–10", titleHi: "प्रश्नावली 4.2, प्रश्न 1–10" },
    {
      title: "Tables of 12 to 15, written twice",
      titleHi: "12 से 15 तक के पहाड़े, दो-दो बार लिखें",
      details: "Say them aloud as you write.",
      detailsHi: "लिखते समय ज़ोर से बोलते जाएँ।",
    },
    { title: "Word problems on page 57", titleHi: "पृष्ठ 57 के इबारती प्रश्न" },
    { title: "Draw and measure five angles with a protractor", titleHi: "चाँदे (प्रोट्रैक्टर) से पाँच कोण बनाएँ और उन्हें नापें" },
    {
      title: "Exercise 5.1, all questions",
      titleHi: "प्रश्नावली 5.1, सभी प्रश्न",
      details: "Show your working for every step.",
      detailsHi: "हर चरण का हल लिखकर दिखाएँ।",
    },
  ],
  "Environmental Education": [
    { title: "Draw and label the parts of a plant", titleHi: "पौधे के भागों का चित्र बनाकर उनके नाम लिखें" },
    {
      title: "List 5 animals found near your home",
      titleHi: "अपने घर के आस-पास पाए जाने वाले 5 जानवरों की सूची बनाएँ",
      details: "Write what each one eats.",
      detailsHi: "हर एक क्या खाता है, यह भी लिखें।",
    },
    { title: "Collect three different leaves and paste them in your copy", titleHi: "तीन अलग-अलग पत्तियाँ इकट्ठी करें और अपनी कॉपी में चिपकाएँ" },
    { title: "Ask your grandparents how water was fetched in their childhood", titleHi: "अपने दादा-दादी या नाना-नानी से पूछें कि उनके बचपन में पानी कैसे लाया जाता था" },
  ],
  Science: [
    { title: "Chapter ‘Light’: answer questions 1–5", titleHi: "अध्याय ‘प्रकाश’: प्रश्न 1–5 के उत्तर लिखें" },
    { title: "Draw a neat diagram of the human digestive system", titleHi: "मानव पाचन तंत्र का साफ़-सुथरा चित्र बनाएँ" },
    { title: "Make a list of 10 materials: conductors and insulators", titleHi: "10 पदार्थों की सूची बनाएँ: सुचालक और कुचालक" },
    {
      title: "Activity: grow gram seeds in wet cotton",
      titleHi: "गतिविधि: गीली रुई में चने के बीज उगाएँ",
      details: "Note the changes every day for four days.",
      detailsHi: "चार दिन तक रोज़ होने वाले बदलाव लिखें।",
    },
  ],
  "Social Science": [
    { title: "Mark the rivers of Rajasthan on the outline map", titleHi: "रेखा-मानचित्र पर राजस्थान की नदियाँ दर्शाएँ" },
    { title: "Chapter 3: write short answers", titleHi: "अध्याय 3: लघु उत्तर लिखें" },
    { title: "Five facts about the Indian Constitution", titleHi: "भारतीय संविधान के बारे में पाँच तथ्य" },
    { title: "Make a timeline of the Mughal emperors", titleHi: "मुग़ल बादशाहों की समय-रेखा बनाएँ" },
  ],
  Sanskrit: [
    { title: "शब्द रूप: ‘बालक’ सभी विभक्तियों में" },
    { title: "Chapter 2: translate the first paragraph into Hindi", titleHi: "अध्याय 2: पहले अनुच्छेद का हिंदी में अनुवाद करें" },
    { title: "Learn 10 new Sanskrit words with meanings", titleHi: "संस्कृत के 10 नए शब्द अर्थ सहित याद करें" },
  ],
  History: [
    { title: "Harappan cities: a one-page note", titleHi: "हड़प्पा के नगर: एक पृष्ठ का नोट" },
    { title: "Map work: important sites of the Indus Valley", titleHi: "मानचित्र कार्य: सिंधु घाटी के महत्वपूर्ण स्थल" },
    { title: "Answer questions 1–4 of chapter 2", titleHi: "अध्याय 2 के प्रश्न 1–4 के उत्तर लिखें" },
  ],
  Geography: [
    { title: "Draw the layers of the Earth's atmosphere", titleHi: "पृथ्वी के वायुमंडल की परतों का चित्र बनाएँ" },
    { title: "Rainfall in Rajasthan: a short note with a map", titleHi: "राजस्थान में वर्षा: मानचित्र सहित एक छोटा नोट" },
    { title: "Chapter 4: define the key terms", titleHi: "अध्याय 4: मुख्य शब्दों की परिभाषा लिखें" },
  ],
  "Political Science": [
    { title: "Fundamental Rights: summarise each in two lines", titleHi: "मौलिक अधिकार: हर एक का सार दो पंक्तियों में लिखें" },
    { title: "Compare the Lok Sabha and the Rajya Sabha", titleHi: "लोकसभा और राज्यसभा की तुलना करें" },
    { title: "News cutting on the gram panchayat, with your comment", titleHi: "ग्राम पंचायत से जुड़ी अख़बार की कतरन, अपनी टिप्पणी के साथ" },
  ],
};

/* ------------------------------------------------------------------ */
/* Remarks (about 10 per school)                                       */
/* ------------------------------------------------------------------ */

export type RemarkIdea = { kind: "appreciation" | "concern"; category: string; note: string; noteHi: string; action?: string; actionHi?: string; family?: boolean };

export const APPRECIATIONS: RemarkIdea[] = [
  {
    kind: "appreciation",
    category: "studies",
    note: "Scored full marks in the weekly maths test and helped two classmates with long division.",
    noteHi: "साप्ताहिक गणित टेस्ट में पूरे अंक मिले, और दो सहपाठियों की लंबे भाग के सवालों में मदद की।",
  },
  {
    kind: "appreciation",
    category: "participation",
    note: "Led the morning assembly with confidence and recited a Hindi poem beautifully.",
    noteHi: "सुबह की प्रार्थना सभा का संचालन आत्मविश्वास से किया और एक हिंदी कविता बहुत सुंदर ढंग से सुनाई।",
  },
  {
    kind: "appreciation",
    category: "homework",
    note: "Has handed in every piece of homework this month, neat and on time.",
    noteHi: "इस महीने का हर गृहकार्य साफ़-सुथरा और समय पर जमा किया है।",
  },
  {
    kind: "appreciation",
    category: "behaviour",
    note: "Very kind to a new classmate and helped her settle in during her first week.",
    noteHi: "एक नई सहपाठी के साथ बहुत अपनापन दिखाया और उसके पहले सप्ताह में उसे घुलने-मिलने में मदद की।",
  },
  {
    kind: "appreciation",
    category: "participation",
    note: "Took part in the tree-planting drive and watered the saplings every day of the week.",
    noteHi: "पौधारोपण अभियान में भाग लिया और पूरे सप्ताह रोज़ पौधों को पानी दिया।",
  },
  {
    kind: "appreciation",
    category: "studies",
    note: "Reading in English has improved a lot — now reads a whole page without help.",
    noteHi: "अंग्रेज़ी पढ़ने में बहुत सुधार हुआ है — अब बच्चा बिना मदद के पूरा पृष्ठ पढ़ लेता है।",
  },
];

export const CONCERNS: RemarkIdea[] = [
  {
    kind: "concern",
    category: "homework",
    note: "Homework was not done three times this week.",
    noteHi: "इस सप्ताह तीन बार गृहकार्य नहीं किया गया।",
    action: "Spoke to the student. Please check the school diary every evening.",
    actionHi: "विद्यार्थी से बात की गई है। कृपया हर शाम स्कूल की डायरी देखें।",
  },
  {
    kind: "concern",
    category: "attendance",
    note: "Came late on four days this month and missed the first period.",
    noteHi: "इस महीने चार दिन देर से आना हुआ और पहला पीरियड छूट गया।",
    action: "Phoned the father on 18 September; he will make sure the child leaves home by 7:30.",
    actionHi: "18 सितंबर को पिताजी से फ़ोन पर बात हुई; वे ध्यान रखेंगे कि बच्चा 7:30 तक घर से निकल जाए।",
  },
  {
    kind: "concern",
    category: "behaviour",
    note: "Pushed a classmate during the games period.",
    noteHi: "खेल के पीरियड में एक सहपाठी को धक्का दिया।",
    action: "Talked to both children and they have made up. Family informed.",
    actionHi: "दोनों बच्चों से बात की गई और अब उनमें सुलह हो गई है। परिवार को सूचित किया गया।",
  },
  {
    kind: "concern",
    category: "studies",
    note: "Finds written English difficult and often leaves answers incomplete.",
    noteHi: "अंग्रेज़ी लिखने में कठिनाई होती है और उत्तर अक्सर अधूरे रह जाते हैं।",
    action: "Extra practice in the library period twice a week.",
    actionHi: "सप्ताह में दो बार पुस्तकालय के पीरियड में अतिरिक्त अभ्यास।",
  },
  {
    kind: "concern",
    category: "other",
    note: "Often comes without the school diary.",
    noteHi: "अक्सर स्कूल की डायरी के बिना आना होता है।",
    action: "Reminded to keep it in the school bag.",
    actionHi: "डायरी स्कूल बैग में रखने की याद दिलाई गई।",
    family: false,
  },
];

export const LOW_ATTENDANCE_CONCERN: RemarkIdea = {
  kind: "concern",
  category: "attendance",
  note: "Absent on many days this month, often without a leave note.",
  noteHi: "इस महीने कई दिन अनुपस्थिति रही, अक्सर बिना अवकाश-पत्र के।",
  action: "Letter sent home asking the family to meet the class teacher.",
  actionHi: "घर पर पत्र भेजा गया है कि परिवार कक्षा अध्यापक से मिले।",
};
