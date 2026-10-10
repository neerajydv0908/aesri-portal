# AESRI Campus Portal

Hi there, and thanks for stopping by! 👋

I'm **Neeraj Yadav**, a master's student in Computer Science at the University of Kansas. From January 2022 to December 2024 I worked at **AESRI (Aryavart Educational and Social Research Institute)**, which runs two schools in Bikaner, Rajasthan. I built these applications for the schools and maintained them.

The project has three parts, each in its own repository:

| Part | What it does |
| --- | --- |
| **[Website](https://github.com/neerajydv0908/aesri-website)** | The public website for AESRI and its two schools |
| **[Campus Portal](https://github.com/neerajydv0908/aesri-portal)** (you are here) | The private portal where families, teachers, the school offices and AESRI sign in |
| **[Stud-AI](https://github.com/neerajydv0908/stud-ai)** | My machine-learning model that helps class teachers see which students may need support |

Let me walk you through the portal.

---

## What it is

The Campus Portal is the private side of the project, for AESRI's two schools: **Aryavart Public School, Palana** (LKG to XII, Arts in XI–XII) and **Aadharshila Public School, Udairamsar** (Nursery to X). Families, teachers, the school offices and AESRI all work in one place:

- **Attendance, homework, marks and report cards**
- **Fees with receipts**, paid online in the family's own amounts, or recorded by the family as paid in cash and then approved by the school
- **Notices and teacher remarks**, with a text message (SMS) to the family whenever something about their child is posted
- **For teachers, Stud-AI's estimate** of which students may need support in each subject

Families can use their pages in English or Hindi, including what teachers and the office write, which is translated into Hindi automatically once the translation service is set up. Staff screens are in English. The public website's *Portal* page (`/portal` on the AESRI website) links here.

## Who uses it

| Person | Signs in as | What they do |
| --- | --- | --- |
| Family (parent or guardian) | `Arya7634` / `Aadhar1234`: school prefix + SR no. | See their child's attendance, homework, results and report cards, fees and receipts, notices, remarks shared by teachers and their profile, in English or Hindi. Pay fees online in their own amounts or record cash paid at the school. Get a text message when something new is posted about their child. |
| Teacher | `AryaE12` / `AadharE12`: prefix + E + employee no. | Take attendance (class teacher), set and check homework, enter marks, write remarks, post class notices, see class lists. As class teacher, write report-card remarks and see the teachers-only "Needs support" view with Stud-AI's estimates. |
| Principal / office admin | Same staff IDs, **with an authenticator app** | Students, staff, Excel import, classes & subjects, sign-in slips, attendance overview, exams & results, fees (including approving the cash payments families record: a red dot on *Fees* while any wait), notices, text messages, activity log, settings, and all the teaching pages. |
| Accountant | Same staff IDs, **with an authenticator app** | Fees (payments, receipts, opening balances, collections) and read-only student lookup. |
| AESRI administrator | e.g. `aesri.deepak`, **with an authenticator app** | Both schools (with a switcher at the top), an overview of both, AESRI administrators, slips for principals and office admins, and the text-message set-up (template IDs, test message). |

**First sign-in and forgotten passwords work with printed slips.** The office prints a slip with the login ID and a one-time code (valid for 14 days, and it works once). The person opens the portal, chooses *Activate your account*, enters the ID and code, and picks a password. A forgotten password just means a new slip. (Sign-in codes by SMS or WhatsApp are planned for after launch. The text messages described below only tell families what was posted.)

---

## Try it on your computer

You'll need **Node.js 20.12 or newer** (22 LTS recommended).

```bash
npm install
npm run demo        # fictional demo data in a built-in database (.data/db)
npm run dev         # http://localhost:3001
```

Demo logins (the password is `demo-pass-2026`, and every person in the demo is fictional):

- AESRI administrator: `aesri.demo`
- Aryavart: principal `AryaE1`, accountant `AryaE2`, teachers `AryaE3`…, families `Arya7601`…
- Aadharshila: principal `AadharE1`, accountant `AadharE2`, teachers `AadharE3`…, families `Aadhar1201`…

Administrators, principals and accountants are asked for an authenticator code after the password. `npm run demo:code` prints the current one, or you can add the key `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP` to Google or Microsoft Authenticator. If you leave "Trust this browser for 30 days" ticked, that browser asks only for the password next time (untick it, or use a private window, to see the code step again).

To start empty instead, like a real school on day one:

```bash
npm run setup                                                   # reference data: schools, session, classes, fee plans
npm run admin:create -- --id aesri.yourname --name "Your Name"   # prints a one-time code
npm run dev                                                     # then Activate your account with that code
```

---

## A closer look at the main features

### Fees: how families pay

- **Admission fee:** a fixed ₹2,000, charged once when a child joins the school and never again in later years. It's paid as one sum.
- **Tuition:** any amount the family chooses, at least ₹1,000 (or whatever is left, if that's less), up to what's left for the session. It goes to the oldest instalment first. The instalment dates (*Fees → Fee plan*) only say what has fallen due.
- **Pay online** with Razorpay, and the receipt appears at once. Or **record a cash payment** made at the school. A recorded cash payment counts only once the principal or an office admin approves it in *Fees → Cash to approve* (Fees in the menu shows a red dot while any wait).
  - **Approved:** it becomes an ordinary cash receipt and the family gets the usual "fee received" text message.
  - **Declined:** the family gets a text message asking them to contact the school office, and sees the reason on the portal.
  - Beside each record the principal sees what is due now and the receipts from the week before, with a warning when one may be the same cash.
- The office can still record counter payments in any amount on the student's fees page. A cash payment the family recorded for the same student shows up there, so the same cash isn't counted twice.

### Hindi for families

When a family chooses **हिं**, everything on their pages is in Hindi. Text that teachers and the office write in English (homework, notices without a Hindi version, remarks, report-card remarks, the school's note on a declined payment) is translated automatically by Microsoft Translator (free tier: 2 million characters a month). Each translation is marked as one, with the original a tap away, and kept so each text is translated only once. Without the service, that text is shown in English and marked as such. The demo data comes with its own Hindi. Set-up and details are in `docs/TRANSLATION.md`, a private guide that isn't in this repository.

### Text messages (SMS)

When a teacher or the office posts something about a child, the family also gets a short text message: attendance marks (absent, late, on leave, present), a remark shared with the family, notices, the day's homework subjects, published results, fee receipts, and a declined cash payment. A notice for one class reaches only that class's families; a notice for chosen students, a mark or a remark reaches only those students' families. Staff get the notices meant for staff. Messages are short and point to the portal. They never contain the text of a remark or any exam marks.

- Each school chooses the events, Hindi or English, the homework-summary time and quiet hours in *Settings → Text messages*. The office sees every message, its status and the reason for any that didn't go out in *Office → Text messages*, and can stop messages for one family on the student's profile.
- Before real messages go out, AESRI registers on DLT (TRAI's rules for business SMS in India) and opens an account with an SMS company (MSG91 or Fast2SMS). The steps, every wording to register and rough costs are in `docs/SMS.md` (private guide, not in this repository). Until then, a live portal records messages as *Not sent — SMS isn't set up yet*.
- On your computer, leave `SMS_PROVIDER` empty: `npm run dev` writes each message to the terminal and shows it as *Sent (test mode)*, so nothing reaches a phone.

### Stud-AI estimates

This is where my [Stud-AI](https://github.com/neerajydv0908/stud-ai) model comes in. Class teachers and administrators see, for each subject, Stud-AI's estimated risk of not passing the next exam as a percentage ("Estimated risk of not passing the next mathematics examination: 62%") with its main reasons, or **Not enough data as of now** for a subject it wasn't trained on.

Each student is then shown as **Needs support** (an estimate of 50% or more in a subject, or low attendance with several concerns), **Review needed**, **Not enough data yet** or **On track**. A subject it wasn't trained on never decides a student's colour on its own, but in any subject, a most recent exam mark below the pass mark, or an absence from that exam, always means Review needed. Raw model probabilities and explanation weights never reach the portal protocol or the browser: only the whole percentage, its sentence and the reasons in words.

Before every load, the portal checks the SHA-256 pins of both the model and its metadata. Inference batches share per-account quotas per minute and per day, and the local queue is bounded. The cache records both verified files and the contract version. Details are in `docs/STUD-AI.md` (private guide, not in this repository).

For local development:

```bash
STUD_AI_DIR=../Stud-AI npm run dev
```

In production, the secrets launcher (`npm start`) reads one JSON secret, either from a locked file outside the app folder (`AESRI_SECRET_FILE`: a systemd credential, or `-` for standard input) or from AWS Secrets Manager, with separate runtime and migration credentials and mandatory model and card pins. Deployment `.env` variants are refused. See `docs/DEPLOYMENT.md` (private guide, not in this repository). Migrations 0004 and 0008 clear only derived Stud-AI results (worked out again on demand), never student records.

---

## Going live

The full guide is `docs/DEPLOYMENT.md` (private, not in this repository): server, database, HTTPS, settings, Razorpay, backups and the legal checklist. Once it's running, the principal's home page shows the office's first steps (*Getting started*):

1. **Classes & subjects:** add the school's subjects.
2. **Import from Excel:** fill in the school's template (download it on the Import page, or use *Data templates* in the project folder) with every student and staff member, upload it, check the preview and confirm. Filled-in spreadsheets stay on your computer, because git never publishes them.
3. **Fees → Opening balances:** enter fees already paid on paper this session (or mark a class as having none), so families don't see paid fees as overdue.
4. **Classes & subjects:** set class teachers and who teaches what.
5. **Slips & sign-in:** print slips, staff first, then families. Right after an import, *Print sign-in slips for the … this import added* prints them all at once (staff by employee number, then students by class, section and roll number, 8 to an A4 sheet). On Slips & sign-in you can also print for everyone not yet activated, one class, or ticked people. Principal and office-admin slips are printed by an AESRI administrator.

Text messages start once AESRI's DLT registration and SMS account are ready (`docs/SMS.md`, and `docs/DEPLOYMENT.md` section 7), and Stud-AI's estimates once Stud-AI is set up (section 8). Neither is needed on day one.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server on port 3001. |
| `npm run production -- build` / `npm start` | Production build/server with the production secret (`docs/DEPLOYMENT.md`). |
| `npm run production -- migrate` / `-- setup` / `-- admin:create --id … --name "…"` | **On the server**, the commands below with the production secrets (set `AESRI_SECRET_FILE` to the locked secret file, or to `-` and pass the file on standard input; or `AESRI_SECRET_ID` and `AWS_REGION` for AWS Secrets Manager). Also `-- sms:send`, `-- payments:check`, `-- signin:unlock <login ID>` and `-- fees:relabel`. Without it, `npm run setup`, `db:migrate` and the rest only see a `.env`, and with no `DATABASE_URL` they use the built-in local database, not the server's PostgreSQL. |
| `npm run setup` | Bring the database up to date and add reference data. Safe to run again. |
| `npm run admin:create -- --id … --name "…"` | Create an AESRI administrator (or `--reset` one) and print a one-time code. |
| `npm run db:migrate` | Apply database migrations (PostgreSQL). |
| `npm run fees:relabel` | Only once, after updating an existing installation (not needed on a new one): renames this session's instalment fee lines to name the student's own class ("Term II — LKG – Class V" → "Term II — Class II", "दूसरी किस्त — कक्षा 2"). Only the wording changes; amounts, payments and receipt numbers stay. One transaction, recorded in the activity log, and safe to run again. Add `-- --dry-run` to see the changes first. With the built-in database, stop the portal while it runs. |
| `npm run demo` / `npm run demo:code` | Fictional demo data (refuses a database that has real people) / the current demo authenticator code. |
| `npm run sms:send` | One pass of the text-message sender, printing what it did (the portal's server normally sends every 30 seconds). With the built-in database, stop the portal and add `-- --local`. |
| `npm run payments:check` | One pass of the Razorpay check for online payments that never got a receipt (the portal's server normally checks every 10 minutes). With the built-in database, stop the portal and add `-- --local`. |
| `npm run signin:unlock -- <login ID>` | Unlock a login ID after too many wrong tries, when nobody who could unlock it in the portal can sign in. With the built-in database, stop the portal and add `--local`. |
| `npm test` | Unit tests: sign-in limits, client address, settings, Excel import checks, zip safety, text messages, what families may pay and recorded cash payments, Hindi translation, exactly what Stud-AI is given, running it and saving its estimates, and the "Needs support" colour rule. |
| `npm run test:e2e` | Browser tests against a fresh demo (see `tests/e2e`). |
| `npm run typecheck` | TypeScript check. |

---

## How I built it

**Next.js 16 (App Router, Server Components, Server Actions) · React 19 · TypeScript · Tailwind CSS 4 · Drizzle ORM on PostgreSQL** (PGlite, an embedded PostgreSQL, when `DATABASE_URL` is empty).

- **Pages:** `app/(auth)` sign-in, activation and two-step sign-in · `app/(app)/my` families · `app/(app)/teach` teachers · `app/(app)/office` school office · `app/(app)/aesri` AESRI · `app/privacy` the privacy notice · `app/api/payments` payment webhooks.
- **Logic:** `lib/services` business rules (each change runs in a transaction with an activity-log entry; `fees.ts` and `cash-claims.ts` handle what families pay and record) · `lib/auth` sessions, passwords, codes, two-step sign-in, limits · `lib/db/schema.ts` every table · `lib/demo` demo data · `lib/sms` text messages (wordings, outbox, sender, the two SMS companies) · `lib/translate` Hindi for families (the translation service and kept translations) · `lib/studai` Stud-AI's estimates (what it's given, running it, saving the answers) · `lib/support` the "Needs support" figures and colour rule.
- **Read `docs/CONVENTIONS.md` before changing code** (private guide, not in this repository): access rules, forms, screens, accessibility and bilingual pages.

### Security and privacy

The portal holds children's records, so I treated security and privacy as part of the design from the start:

- **Who sees what.** Every page and action checks who is signed in and what they may see. Families only ever reach their own child, and each school only its own records.
- **Passwords and codes.** Passwords are hashed (scrypt), one-time codes are stored only as keyed fingerprints, authenticator keys are encrypted, and admin-type accounts must use two-step sign-in.
- **Trusted browsers.** After a correct authenticator code, an administrator can trust that browser for 30 days: signing in there then needs the password only, never less. The browser holds a random token, and the portal keeps only its SHA-256, tied to the account and its authenticator key. *Password and sign-in* lists trusted browsers and can forget one or all of them. Signing out on all other devices or changing the password forgets the others, and a new slip, turning sign-in off or a change of access forgets every one.
- **Wrong tries are limited** per login ID, per ID and address, per address, and to 100 a day per login ID (after that, one try every 10 minutes for the rest of the day). A phone or computer that has signed in to an account before keeps its own allowance, so someone guessing elsewhere can't lock the family out. On a new device they get those 10-minute tries, or the office unlocks it (printing a new slip clears the counters too). Twenty wrong authenticator codes in a row lock two-step sign-in until it's unlocked. The office (and AESRI administrators, for each other) can see and clear a lock.
- **Payments.** Online payments use Razorpay's hosted checkout, so the portal never sees card or bank details, and it checks every payment's signature on the server. Payments that never got a receipt are found by asking Razorpay every 10 minutes. Refunds (Razorpay's, or money given back at the office) are recorded with their own voucher numbers and show everywhere as money paid out. An office refund entered by mistake can be cancelled, and it stays on record.
- **Cash claims.** A cash payment a family records is only a claim until the principal or an office admin approves it. The accountant sees it but can't approve it, and every step is in the activity log.
- **No tracking.** A strict Content-Security-Policy, no third-party scripts except Razorpay's checkout, no trackers or analytics, and private pages are never cached.
- **Records.** Every change is recorded in the activity log, and the portal holds no Aadhaar numbers, caste, bank or health data.
- **Text messages** carry no remark text and no exam marks. The office's message list shows numbers masked (`98•••••12`), and after 180 days a message's text and number are cleared.
- **Translation** sends only the text staff wrote, as written (the portal adds no names or records), to Microsoft Translator, which doesn't keep it (it may process it outside India). Translations unread for 180 days, or of a remark that was deleted, are deleted. With translation off, nothing is sent.
- **Stud-AI** runs on the school's own server, after the usual access checks. It's given only numbers under the portal's IDs (never names), gets none of the portal's secrets, and its estimates are shown to class teachers and admins only, never to families or students.

---

## What's still on my list

None of these block launch:

- **Instalment split:** fees are split 50/50 as a placeholder (Term I due 10 April, Term II due 15 September). Families pay tuition in their own amounts (from ₹1,000), so the split only sets what falls due when. It should be changed on *Fees → Fee plan* before any payment is recorded.
- **Hindi translation:** AESRI's Microsoft Translator resource (Azure, free tier F0), and listing Microsoft in the privacy notice (`docs/TRANSLATION.md`).
- **Privacy notice** (`/privacy`): a draft for AESRI to approve, plus the AESRI privacy contact.
- The SLFC approval reference for the fee plans, and AESRI's office address (shown on the public website).
- **Text messages:** AESRI's DLT registration, the two schools' 6-letter headers and the SMS company account (`docs/SMS.md`), including the new "Recorded cash payment declined" wording, and each school's choice of events and language.
- **Stud-AI:** retrain and re-test the model on AESRI's own past records before teachers rely on it (the dataset it was trained on isn't the schools' own), have the principals agree the "Needs support" colour rule (*Settings*), and have AESRI approve the privacy notice's wording about it.
- **After launch:** sign-in codes by SMS or WhatsApp for forgotten passwords.

---

## Thanks for reading!

If you have questions or ideas about the project, you can find me on GitHub at [@neerajydv0908](https://github.com/neerajydv0908).

— Neeraj
