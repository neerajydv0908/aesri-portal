import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import clsx from "clsx";
import { CheckCircle2, CircleDashed } from "lucide-react";
import { ActionForm } from "@/components/forms";
import { TextField } from "@/components/access/fields";
import { InfoList } from "@/components/access/info-list";
import { Alert, Badge, Card, CardTitle, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/ui/client";
import { getDb } from "@/lib/db/client";
import { schools } from "@/lib/db/schema";
import { officeSchoolId, requireActor } from "@/lib/auth/dal";
import { smsSetup } from "@/lib/queries/sms";
import { senderIdFor } from "@/lib/sms/config";
import { loadTemplateIds, resolveSmsSettings, schoolNameIn, templateIdFor, templateIdKey } from "@/lib/sms/settings";
import {
  dltWording,
  exampleSms,
  smsSize,
  SMS_LANG_NAMES,
  SMS_LANGS,
  TEMPLATE_KEYS,
  TEMPLATES,
  templateVars,
  VAR_SPECS,
  type FixedText,
  type SmsLang,
  type TemplateKey,
} from "@/lib/sms/templates";
import { TestSmsCard } from "../../office/sms/test-form";
import { saveTemplateIdsAction } from "./actions";

export const metadata: Metadata = { title: "Text messages (AESRI)" };

function sizeWords(text: string): string {
  const s = smsSize(text);
  return `${s.length} characters, ${s.encoding === "gsm" ? "plain text" : "Unicode"}: ${s.parts} ${s.parts === 1 ? "SMS" : "SMS parts"}`;
}

export default async function AesriSmsPage({ searchParams }: { searchParams: Promise<{ school?: string }> }) {
  const actor = await requireActor(["super_admin"]);
  const sp = await searchParams;
  const current = await officeSchoolId(actor);
  const db = await getDb();
  const [ids, list] = await Promise.all([loadTemplateIds(db), db.select().from(schools).orderBy(schools.id)]);
  // The school whose wordings are shown: the one asked for, else the school chosen at the top of the portal.
  const chosen = list.find((s) => s.id === sp.school) ?? list.find((s) => s.id === current) ?? list[0];
  if (!chosen) notFound();
  const setup = smsSetup();
  const live = setup.provider !== "log";
  const needsSender = setup.provider === "fast2sms";
  const langsUsed = [...new Set(list.map((s) => resolveSmsSettings(s.settings.sms).lang))];
  const idsIn = (schoolId: string, lang: SmsLang) => TEMPLATE_KEYS.filter((k) => templateIdFor(ids, setup.provider, schoolId, k, lang)).length;
  const fixed = Object.fromEntries(SMS_LANGS.map((l) => [l, { school: schoolNameIn(chosen, l), portal: setup.portal }])) as Record<SmsLang, FixedText>;
  const chosenLang = resolveSmsSettings(chosen.settings.sms).lang;

  return (
    <>
      <PageHeader
        eyebrow="AESRI"
        title="Text messages"
        description="Set up text messages (SMS) for both schools: the SMS company, and each school’s message wordings registered on DLT with their template IDs. docs/SMS.md explains the steps."
      />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardTitle>SMS company</CardTitle>
          {setup.mode === "test" ? (
            <Alert tone="amber" className="mb-5" title="Test mode">
              SMS_PROVIDER isn’t set, so messages are written to the server’s log and marked “Sent (test mode)”. Nothing reaches a phone.
            </Alert>
          ) : setup.mode === "off" ? (
            <Alert tone="amber" className="mb-5" title="Not set up">
              SMS_PROVIDER isn’t set on this server, so every message is recorded as “Not sent (SMS isn’t set up yet)”.
            </Alert>
          ) : null}
          <InfoList
            items={[
              { label: "Company (SMS_PROVIDER)", value: setup.providerLabel },
              ...(live
                ? [
                    {
                      label: setup.provider === "msg91" ? "Auth key (MSG91_AUTH_KEY)" : "API key (FAST2SMS_API_KEY)",
                      value: setup.keySet ? (
                        <Badge tone="green">
                          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                          Set on the server
                        </Badge>
                      ) : (
                        <Badge tone="red">Not set</Badge>
                      ),
                    },
                  ]
                : []),
              {
                label: "Portal address in the messages",
                value: (
                  <>
                    <span className="font-semibold tabular">{setup.portal}</span>
                    <span className="mt-1 block text-[0.88rem] text-muted">
                      Written into the templates as fixed text. Whitelist it on DLT (links must be whitelisted), and register the templates again if it ever changes.
                    </span>
                  </>
                ),
              },
            ]}
          />
          <p className="mt-5 text-[0.9rem] text-muted">Keys are set in the server’s environment and are never shown here. Changing them needs a restart.</p>
        </Card>

        <Card>
          <CardTitle>Schools</CardTitle>
          <ul className="grid gap-4">
            {list.map((s) => {
              const st = resolveSmsSettings(s.settings.sms);
              const on = Object.values(st.events).filter(Boolean).length;
              const sender = senderIdFor(s.id);
              return (
                <li key={s.id}>
                  <p className="font-semibold text-forest-900">{s.name}</p>
                  <p className="text-[0.92rem] text-muted">
                    {st.enabled ? `On: ${on} of ${Object.keys(st.events).length} events` : "Switched off"} · messages in {SMS_LANG_NAMES[st.lang]}
                    {st.alsoSecondMobile ? " · also to second mobiles" : ""}
                  </p>
                  <p className="text-[0.92rem] text-muted">
                    Sender ID (SMS_SENDER_ID):{" "}
                    {sender ? (
                      <span className="font-semibold text-forest-900 tabular">{sender}</span>
                    ) : needsSender ? (
                      <span className="font-semibold text-clay-600">not set — Fast2SMS can’t send this school’s messages</span>
                    ) : setup.provider === "msg91" ? (
                      "taken from each MSG91 template"
                    ) : (
                      "not set (not needed in test mode)"
                    )}
                  </p>
                  {live ? (
                    <p className="text-[0.92rem] text-muted">
                      Template IDs in {SMS_LANG_NAMES[st.lang]}: {idsIn(s.id, st.lang)} of {TEMPLATE_KEYS.length}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="mt-5 text-[0.9rem] text-muted">Each school chooses its events and language on its own Settings page.</p>
        </Card>
      </div>

      <section aria-labelledby="templates" className="mt-10 scroll-mt-24" id="wordings">
        <h2 id="templates" className="font-display text-[1.45rem] text-forest-900">
          Message wordings to register
        </h2>
        <p className="mt-1 max-w-3xl text-muted">
          Each school registers its own copy of every wording: DLT wants the school’s name written into the template, not filled in. Register each one exactly as shown, as a
          “Service Implicit” content template under that school’s sender ID. Each {"{#alphanumeric#}"} is a variable the portal fills in, never more than 30 characters (typed
          variables replaced {"{#var#}"} for new templates in 2026). Only the languages the schools use need registering now (
          {langsUsed.map((l) => SMS_LANG_NAMES[l]).join(" and ")}).
        </p>

        <nav aria-label="Choose the school" className="mt-5 flex max-w-full gap-1 overflow-x-auto rounded-full bg-cream-200/70 p-1 sm:w-fit">
          {list.map((s) => (
            <Link
              key={s.id}
              href={`/aesri/sms?school=${s.id}#wordings`}
              aria-current={s.id === chosen.id ? "page" : undefined}
              className={clsx(
                "flex min-h-11 items-center whitespace-nowrap rounded-full px-4 text-[0.9rem] font-semibold transition-colors",
                s.id === chosen.id ? "bg-cream-50 text-forest-900 shadow-sm" : "text-muted hover:text-forest-900",
              )}
            >
              {s.name}
            </Link>
          ))}
        </nav>

        <p className="mt-4 text-[0.95rem] text-forest-900">
          <span className="font-semibold">{chosen.name}</span>
          <span className="text-muted">
            {" "}
            · messages in {SMS_LANG_NAMES[chosenLang]}
            {live ? ` · ${idsIn(chosen.id, chosenLang)} of ${TEMPLATE_KEYS.length} template IDs entered in ${SMS_LANG_NAMES[chosenLang]}` : ""}
          </span>
        </p>

        {!live ? (
          <Alert tone="blue" className="mt-4">
            Template IDs can be entered here once SMS_PROVIDER names the SMS company (msg91 or fast2sms) and the server has been restarted.
          </Alert>
        ) : null}
        {/* Keyed by school: switching schools must not carry one school's typed IDs over to the other. */}
        <ActionForm key={chosen.id} action={saveTemplateIdsAction} aria-label={`Template IDs for ${chosen.name}`} className="mt-5 gap-5">
          <input type="hidden" name="school" value={chosen.id} />
          {TEMPLATE_KEYS.map((key) => (
            <TemplateCard
              key={key}
              k={key}
              fixed={fixed}
              provider={live ? setup.providerLabel : null}
              ids={SMS_LANGS.map((l) => templateIdFor(ids, setup.provider, chosen.id, key, l) ?? "")}
            />
          ))}
          {live ? (
            <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-forest-900/10 bg-cream-50/95 px-4 py-3 backdrop-blur">
              <p className="text-[0.88rem] text-muted">Leave a box empty while a wording isn’t approved yet: those messages are recorded as “Not sent”.</p>
              <SubmitButton pendingLabel="Saving…">Save {chosen.name}’s template IDs</SubmitButton>
            </div>
          ) : null}
        </ActionForm>
      </section>

      <div className="mt-10 max-w-2xl">
        <TestSmsCard key={chosen.id} defaultLang={chosenLang} schoolId={chosen.id} schoolName={chosen.name} />
      </div>
    </>
  );
}

function TemplateCard({ k, fixed, provider, ids }: { k: TemplateKey; fixed: Record<SmsLang, FixedText>; provider: string | null; ids: string[] }) {
  const t = TEMPLATES[k];
  return (
    <Card as="article">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-[1.25rem] text-forest-900">{t.name}</h3>
        <span className="font-mono text-[0.82rem] text-muted">{k}</span>
      </div>
      <p className="mt-1 text-[0.92rem] text-muted">{t.purpose}</p>
      <div className="mt-4 grid gap-6 xl:grid-cols-2">
        {SMS_LANGS.map((lang, i) => {
          const example = exampleSms(k, lang, fixed[lang]);
          const vars = templateVars(k, lang);
          const fieldName = `id:${templateIdKey(k, lang)}`;
          return (
            <div key={lang} className="grid content-start gap-3">
              <p className="flex items-center gap-2 text-[0.92rem] font-semibold text-forest-900">
                {SMS_LANG_NAMES[lang]}
                {provider ? (
                  ids[i] ? (
                    <Badge tone="green">
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                      ID entered
                    </Badge>
                  ) : (
                    <Badge tone="grey">
                      <CircleDashed className="h-3.5 w-3.5" aria-hidden />
                      No ID yet
                    </Badge>
                  )
                ) : null}
              </p>
              <div>
                <p className="eyebrow">Wording to register</p>
                <p lang={lang} className="mt-1 break-words rounded-xl bg-cream-100 px-3 py-2 font-mono text-[0.88rem] leading-relaxed text-forest-900 ring-1 ring-forest-900/10">
                  {dltWording(k, lang, fixed[lang])}
                </p>
              </div>
              <div>
                <p className="eyebrow">Variables, in order</p>
                {vars.length ? (
                  <ol className="mt-1 grid list-decimal gap-1 pl-6 text-[0.9rem] text-forest-900">
                    {vars.map((v, n) => (
                      <li key={v}>
                        {VAR_SPECS[v].label} <span className="text-muted">(up to {VAR_SPECS[v].max}; e.g. </span>
                        <span lang={lang}>{example.vars[n]}</span>
                        <span className="text-muted">)</span>
                        {provider === "MSG91" ? <span className="text-muted"> · MSG91 name var{n + 1}</span> : null}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="mt-1 text-[0.9rem] text-forest-900">None: this wording is sent exactly as registered.</p>
                )}
              </div>
              <div>
                <p className="eyebrow">Example</p>
                <p lang={lang} className="mt-1 break-words text-[0.92rem] text-forest-900">
                  {example.body}
                </p>
                <p className="mt-0.5 text-[0.82rem] text-muted">{sizeWords(example.body)}</p>
              </div>
              {provider ? (
                <TextField
                  name={fieldName}
                  label={`${provider} template ID (${SMS_LANG_NAMES[lang]})`}
                  defaultValue={ids[i]}
                  autoComplete="off"
                  spellCheck={false}
                  inputClassName="font-mono text-[0.9rem]"
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
