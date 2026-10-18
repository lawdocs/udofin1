import {
  LR_ARTEFACT_STATUSES,
  LR_CHANNELS,
  LR_HOLD_STATUSES,
  LR_REMINDER_KINDS,
  LR_REMINDER_STATUSES,
  LR_SUPPRESS_REASONS,
  LR_TEMPLATE_LANGUAGES,
  type LrOverdueReminders,
  type LrPenalText,
  type LrPolicy,
  type LrTemplate,
} from '@udofin/contracts';
import { type ReactNode } from 'react';
import { OpForm } from '../onboarding/forms.js';
import { EmptyList, LoadFailure, Paging, Section } from '../servicing/common.js';
import {
  formatCount,
  formatDate,
  formatIst,
  formatRupees,
  istOrDash,
} from '../servicing/format.js';
import {
  mayApprove,
  mayIn,
  mayRetire,
  mayViewArtefacts,
  remindersHref,
  withoutCursor,
  type RemindersGrant,
  type RemindersQuery,
} from './data.js';
import {
  LenderPicker,
  OverdueNotice,
  Person,
  RemindersNav,
  RemindersNotice,
  Trail,
  type Loaded,
  type RemindersContext,
} from './common.js';
import {
  HoldPlaceFields,
  PenalDraftFields,
  PolicyDraftFields,
  TemplateDraftFields,
} from './draft-forms.js';
import { CheckInput, SelectInput, TextInput } from './fields.js';
import {
  artefactStatusShort,
  artefactStatusWords,
  channelWords,
  chargeBasisWords,
  chargeKindWords,
  deliveryErrorWords,
  deliverySourceWords,
  deliveryStateWords,
  holdReasonWords,
  holdStatusWords,
  languageWords,
  offsetWords,
  percentFromBps,
  reminderKindWords,
  reminderStatusShort,
  suppressReasonWords,
} from './wording.js';
import {
  type LrDeliveryLog,
  type LrHoldPage,
  type LrPenalTextPage,
  type LrPolicyPage,
  type LrReminderPage,
  type LrReminderSummary,
  type LrTemplatePage,
} from './types.js';

// ---------------------------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------------------------
const options = (values: readonly string[], words: (value: string) => string) =>
  values.map((value) => ({ value, label: words(value) }));

/** The status filter of the artefact lists: a plain GET form, no write. */
function StatusFilter({
  path,
  lenderId,
  query,
  extra,
}: {
  path: string;
  lenderId: string;
  query: RemindersQuery;
  extra?: ReactNode;
}) {
  return (
    <form method="get" action={path} className="inline">
      <input type="hidden" name="lenderId" value={lenderId} />
      <SelectInput
        name="status"
        label="Version status"
        blank="All versions"
        options={options(LR_ARTEFACT_STATUSES, artefactStatusShort)}
        defaultValue={query.status}
      />
      {extra}
      <button type="submit" className="secondary">
        Show
      </button>
    </form>
  );
}

/** The approve form: drawn only for a draft by ANOTHER person, for a person who holds the approve permission in that lender. */
function ApproveForm({
  kind,
  id,
  noun,
  ctx,
}: {
  kind: 'policy' | 'template' | 'penal';
  id: string;
  noun: string;
  ctx: RemindersContext;
}) {
  return (
    <OpForm
      op={`reminders.${kind}.approve`}
      action={ctx.action}
      returnTo={ctx.returnTo}
      hidden={{ id }}
      submit={`Approve this ${noun}`}
    >
      <CheckInput name="reviewed" label={`I have read this ${noun} in full.`} required />
    </OpForm>
  );
}

function RetireForm({
  kind,
  id,
  status,
  noun,
  ctx,
}: {
  kind: 'policy' | 'template' | 'penal';
  id: string;
  status: string;
  noun: string;
  ctx: RemindersContext;
}) {
  return (
    <OpForm
      op={`reminders.${kind}.retire`}
      action={ctx.action}
      returnTo={ctx.returnTo}
      hidden={{ id }}
      submit={status === 'draft' ? `Retire this draft` : `Retire this ${noun}`}
      secondary
    />
  );
}

/** The actions on one version, each drawn only when the person may take it. */
function VersionActions({
  kind,
  noun,
  version,
  lenderId,
  ctx,
  retireWarning,
}: {
  kind: 'policy' | 'template' | 'penal';
  noun: string;
  version: { id: string; status: string; draftedBy: string };
  lenderId: string;
  ctx: RemindersContext;
  retireWarning?: string;
}) {
  const approve = mayApprove(ctx.grants, lenderId, version, ctx.userId);
  const retire = mayRetire(ctx.grants, lenderId, version);
  const own = version.status === 'draft' && version.draftedBy === ctx.userId;
  return (
    <>
      {own ? (
        <p className="muted">You drafted this version, so another person must approve it.</p>
      ) : null}
      {approve ? <ApproveForm kind={kind} id={version.id} noun={noun} ctx={ctx} /> : null}
      {retire ? (
        <>
          {retireWarning ? <p className="muted">{retireWarning}</p> : null}
          <RetireForm kind={kind} id={version.id} status={version.status} noun={noun} ctx={ctx} />
        </>
      ) : null}
    </>
  );
}

function NoLender({ what }: { what: string }) {
  return <LoadFailure what={what} status={403} />;
}

const idOf = (prefix: string, id: string) => `${prefix}-${id}`;

// ---------------------------------------------------------------------------------------------------------------
// Reminder log and summary
// ---------------------------------------------------------------------------------------------------------------
function SummaryTable({ summary }: { summary: LrReminderSummary }) {
  if (summary.items.length === 0) return <p>No reminder is counted for this period yet.</p>;
  return (
    <>
      <p className="muted">
        {summary.since === null
          ? 'Counts of messages scheduled in the period the service uses when none is chosen (the last 30 days).'
          : `Counts of messages scheduled at or after ${formatIst(summary.since)}.`}{' '}
        Counts only; no borrower or loan is named.
      </p>
      <table>
        <caption>Reminders by status, reason and channel</caption>
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col">Reason it was not sent</th>
            <th scope="col">Channel</th>
            <th scope="col">Count</th>
          </tr>
        </thead>
        <tbody>
          {summary.items.map((row, index) => (
            <tr key={`${row.status}-${row.suppressReason ?? ''}-${row.channel}-${String(index)}`}>
              <th scope="row">{reminderStatusShort(row.status)}</th>
              <td>{row.suppressReason === null ? '—' : suppressReasonWords(row.suppressReason)}</td>
              <td>{channelWords(row.channel)}</td>
              <td>{formatCount(row.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function RemindersLogPage({
  lender,
  summary,
  reminders,
  overdue,
  query,
  ctx,
  done,
  error,
}: {
  lender: RemindersGrant | null;
  summary: Loaded<LrReminderSummary> | null;
  reminders: Loaded<LrReminderPage>;
  overdue: LrOverdueReminders | null;
  query: RemindersQuery;
  ctx: RemindersContext;
  done?: boolean;
  error?: string | undefined;
}) {
  const lenders = ctx.grants.filter((g) => g.read);
  return (
    <div>
      <h1>Reminders</h1>
      <RemindersNav current="/reminders" />
      <p>
        Service reminders go to borrowers in the app and as push notifications only. SMS is not
        available and is never sent. Your organisation writes the policy, the wording and the
        penal-charge text, and another person in your organisation approves each of them. Udofin
        sends only what was approved.
      </p>
      <RemindersNotice done={done} error={error} />
      {lender === null ? (
        <NoLender what="the reminder log" />
      ) : (
        <>
          <LenderPicker lenders={lenders} selected={lender.lenderId} path="/reminders" />
          <OverdueNotice overdue={overdue} />
          <Section title="Summary">
            {summary === null ? null : !summary.ok ? (
              <LoadFailure what="the summary" status={summary.status} />
            ) : (
              <SummaryTable summary={summary.data} />
            )}
          </Section>
          <Section title="Reminder log">
            <form method="get" action="/reminders" className="inline">
              <input type="hidden" name="lenderId" value={lender.lenderId} />
              <SelectInput
                name="status"
                label="Status"
                blank="All statuses"
                options={options(LR_REMINDER_STATUSES, reminderStatusShort)}
                defaultValue={query.status}
              />
              <SelectInput
                name="kind"
                label="Kind"
                blank="All kinds"
                options={options(LR_REMINDER_KINDS, reminderKindWords)}
                defaultValue={query.kind}
              />
              <SelectInput
                name="channel"
                label="Channel"
                blank="All channels"
                options={options(LR_CHANNELS, channelWords)}
                defaultValue={query.channel}
              />
              <SelectInput
                name="suppressReason"
                label="Reason it was not sent"
                blank="Any reason"
                options={options(LR_SUPPRESS_REASONS, suppressReasonWords)}
                defaultValue={query.suppressReason}
              />
              <TextInput
                name="loanAccountId"
                label="Loan ID (optional)"
                defaultValue={query.loanAccountId}
                hint="The ID in the address of the loan’s page."
              />
              <button type="submit" className="secondary">
                Show
              </button>
            </form>
            {!reminders.ok ? (
              <LoadFailure what="the reminders" status={reminders.status} />
            ) : reminders.data.items.length === 0 ? (
              <EmptyList
                title="No reminders"
                detail="A reminder appears here after the service plans it for a loan. Nothing is planned until reminders are switched on for your organisation and a policy and wording are approved."
              />
            ) : (
              <>
                <table>
                  <caption>Reminders, newest first</caption>
                  <thead>
                    <tr>
                      <th scope="col">Scheduled</th>
                      <th scope="col">Message</th>
                      <th scope="col">Channel</th>
                      <th scope="col">Status</th>
                      <th scope="col">Reason it was not sent</th>
                      <th scope="col">Amount the lender reported</th>
                      <th scope="col">Language used</th>
                      <th scope="col">Attempts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reminders.data.items.map((r) => (
                      <tr key={r.id}>
                        <th scope="row">{formatIst(r.scheduledFor)}</th>
                        <td>
                          {reminderKindWords(r.kind)}: {offsetWords(r.offsetDays)}, instalment{' '}
                          {formatCount(r.installmentSeq)} due {formatDate(r.dueDate)}
                          <br />
                          <a href={`/loans/${r.loanAccountId}`}>The loan</a>
                        </td>
                        <td>{channelWords(r.channel)}</td>
                        <td>{reminderStatusShort(r.status)}</td>
                        <td>
                          {r.suppressReason === null ? '—' : suppressReasonWords(r.suppressReason)}
                        </td>
                        <td>
                          {r.amountMinor === null
                            ? 'No amount recorded'
                            : formatRupees(r.amountMinor)}
                        </td>
                        <td>
                          {r.languageUsed === null
                            ? '—'
                            : r.languageFallback
                              ? `${languageWords(r.languageUsed)} (used because no approved Hindi wording was available)`
                              : languageWords(r.languageUsed)}
                        </td>
                        <td>
                          {formatCount(r.attempts)}{' '}
                          <a href={`/reminders/${r.id}`}>
                            View attempts{' '}
                            <span className="sr-only">
                              for the reminder scheduled {formatIst(r.scheduledFor)}
                            </span>
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Paging
                  nextHref={
                    reminders.data.nextCursor
                      ? remindersHref('/reminders', {
                          ...query,
                          lenderId: lender.lenderId,
                          cursor: reminders.data.nextCursor,
                        })
                      : null
                  }
                  firstHref={remindersHref('/reminders', {
                    ...withoutCursor(query),
                    lenderId: lender.lenderId,
                  })}
                  hasCursor={query.cursor !== undefined}
                  noun="reminders"
                />
              </>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Attempts of one reminder
// ---------------------------------------------------------------------------------------------------------------
export function ReminderAttemptsPage({ log }: { log: Loaded<LrDeliveryLog> }) {
  return (
    <div>
      <h1>Attempts for one reminder</h1>
      <RemindersNav current={null} />
      <p>
        <a href="/reminders">Back to the reminder log</a>
      </p>
      {!log.ok ? (
        log.status === 404 ? (
          <EmptyList
            title="Reminder not found"
            detail="That reminder is not one of your organisation’s, or it does not exist."
          />
        ) : (
          <LoadFailure what="the attempts" status={log.status} />
        )
      ) : log.data.items.length === 0 ? (
        <EmptyList
          title="No attempt recorded"
          detail="No attempt to send this reminder has been recorded."
        />
      ) : (
        <>
          <p className="muted">
            Oldest first. “Accepted” means the channel took the message. It is not a delivery
            report; a message counts as delivered only when a delivery report says so.
          </p>
          <table>
            <caption>Attempts, oldest first</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Channel</th>
                <th scope="col">What happened</th>
                <th scope="col">Source</th>
                <th scope="col">Problem</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {log.data.items.map((d) => (
                <tr key={d.id}>
                  <th scope="row">{formatIst(d.occurredAt)}</th>
                  <td>{channelWords(d.channel)}</td>
                  <td>{deliveryStateWords(d.state)}</td>
                  <td>{deliverySourceWords(d.source)}</td>
                  <td>{deliveryErrorWords(d.errorClass)}</td>
                  <td>
                    <details>
                      <summary>Fingerprints</summary>
                      <p className="muted">
                        SHA-256 of the wording that was sent, and of the penal-charge sentence it
                        carried. The wording itself is not stored here.
                      </p>
                      <p>
                        Wording: <code>{d.contentSha256}</code>
                      </p>
                      <p>
                        Penal-charge sentence:{' '}
                        {d.penalTextSha256 === null ? (
                          'none carried'
                        ) : (
                          <code>{d.penalTextSha256}</code>
                        )}
                      </p>
                      {d.providerRef === null ? null : (
                        <p>
                          Channel reference: <code>{d.providerRef}</code>
                        </p>
                      )}
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------------------------------------------
function PolicyDraftForm({ lenderId, ctx }: { lenderId: string; ctx: RemindersContext }) {
  return (
    <Section title="Draft a new policy">
      <p>
        A policy says when reminders are planned for each due date, on which channels, in which
        daily window and how many per loan per day. Your organisation decides every value; none is
        suggested. Another person must approve the draft before it is used, and approving it retires
        the previous version.
      </p>
      <PolicyDraftFields lenderId={lenderId} action={ctx.draft} returnTo={ctx.returnTo} />
    </Section>
  );
}

function PolicyCard({ policy, ctx }: { policy: LrPolicy; ctx: RemindersContext }) {
  const titleId = idOf('policy', policy.id);
  return (
    <article className="card" aria-labelledby={titleId}>
      <h3 id={titleId}>
        Version {formatCount(policy.version)}: {artefactStatusShort(policy.status)}
      </h3>
      <p className="muted">{artefactStatusWords(policy.status)}</p>
      <dl className="facts">
        <div>
          <dt>When reminders are planned</dt>
          <dd>
            <ul>
              {policy.offsetsDays.map((days) => (
                <li key={days}>{offsetWords(days)}</li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>Weekly overdue reminders</dt>
          <dd>{policy.overdueWeekly ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt>Channels</dt>
          <dd>
            <ul>
              {policy.channels.map((channel) => (
                <li key={channel}>{channelWords(channel)}</li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>Daily window (India time)</dt>
          <dd>
            From {policy.windowFrom} to {policy.windowTo}
          </dd>
        </div>
        <div>
          <dt>Most messages per loan per day</dt>
          <dd>{formatCount(policy.maxPerDay)}</dd>
        </div>
        <Trail
          userId={ctx.userId}
          draftedBy={policy.draftedBy}
          draftedAt={policy.draftedAt}
          approvedBy={policy.approvedBy}
          approvedAt={policy.approvedAt}
          retiredBy={policy.retiredBy}
          retiredAt={policy.retiredAt}
        />
      </dl>
      <VersionActions
        kind="policy"
        noun="policy"
        version={policy}
        lenderId={policy.lenderId}
        ctx={ctx}
      />
    </article>
  );
}

export function PolicyPage({
  lender,
  page,
  query,
  ctx,
  done,
  error,
}: {
  lender: RemindersGrant | null;
  page: Loaded<LrPolicyPage>;
  query: RemindersQuery;
  ctx: RemindersContext;
  done?: boolean;
  error?: string | undefined;
}) {
  const lenders = ctx.grants.filter(mayViewArtefacts);
  return (
    <div>
      <h1>Reminder policy</h1>
      <RemindersNav current="/reminders/policy" />
      <RemindersNotice done={done} error={error} />
      {lender === null ? (
        <NoLender what="the reminder policy" />
      ) : (
        <>
          <LenderPicker lenders={lenders} selected={lender.lenderId} path="/reminders/policy" />
          <OverdueNotice overdue={page.ok ? page.data.overdueReminders : null} />
          {mayIn(ctx.grants, lender.lenderId, 'manage') ? (
            <PolicyDraftForm lenderId={lender.lenderId} ctx={ctx} />
          ) : null}
          <Section title="Versions">
            <StatusFilter path="/reminders/policy" lenderId={lender.lenderId} query={query} />
            {!page.ok ? (
              <LoadFailure what="the policy" status={page.status} />
            ) : page.data.items.length === 0 ? (
              <EmptyList
                title="No policy yet"
                detail="No version has been drafted for this lender. Reminders are not planned without an approved policy."
              />
            ) : (
              <>
                {page.data.items.map((policy) => (
                  <PolicyCard key={policy.id} policy={policy} ctx={ctx} />
                ))}
                <Paging
                  nextHref={
                    page.data.nextCursor
                      ? remindersHref('/reminders/policy', {
                          ...query,
                          lenderId: lender.lenderId,
                          cursor: page.data.nextCursor,
                        })
                      : null
                  }
                  firstHref={remindersHref('/reminders/policy', {
                    ...withoutCursor(query),
                    lenderId: lender.lenderId,
                  })}
                  hasCursor={query.cursor !== undefined}
                  noun="versions"
                />
              </>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------------------------------------------
function TemplateDraftForm({ lenderId, ctx }: { lenderId: string; ctx: RemindersContext }) {
  return (
    <Section title="Draft new wording">
      <TemplateDraftFields lenderId={lenderId} action={ctx.draft} returnTo={ctx.returnTo} />
    </Section>
  );
}

function TemplateCard({ template, ctx }: { template: LrTemplate; ctx: RemindersContext }) {
  const titleId = idOf('template', template.id);
  return (
    <article className="card" aria-labelledby={titleId}>
      <h3 id={titleId}>
        {reminderKindWords(template.kind)}, {languageWords(template.language)}: version{' '}
        {formatCount(template.version)}, {artefactStatusShort(template.status)}
      </h3>
      <p className="muted">{artefactStatusWords(template.status)}</p>
      <dl className="facts">
        <div>
          <dt>Wording exactly as saved</dt>
          <dd>{template.body}</dd>
        </div>
        <Trail
          userId={ctx.userId}
          draftedBy={template.draftedBy}
          draftedAt={template.draftedAt}
          approvedBy={template.approvedBy}
          approvedAt={template.approvedAt}
          retiredBy={template.retiredBy}
          retiredAt={template.retiredAt}
        />
      </dl>
      <VersionActions
        kind="template"
        noun="wording"
        version={template}
        lenderId={template.lenderId}
        ctx={ctx}
      />
    </article>
  );
}

export function WordingPage({
  lender,
  page,
  query,
  ctx,
  done,
  error,
}: {
  lender: RemindersGrant | null;
  page: Loaded<LrTemplatePage>;
  query: RemindersQuery;
  ctx: RemindersContext;
  done?: boolean;
  error?: string | undefined;
}) {
  const lenders = ctx.grants.filter(mayViewArtefacts);
  return (
    <div>
      <h1>Reminder wording</h1>
      <RemindersNav current="/reminders/wording" />
      <RemindersNotice done={done} error={error} />
      {lender === null ? (
        <NoLender what="the reminder wording" />
      ) : (
        <>
          <LenderPicker lenders={lenders} selected={lender.lenderId} path="/reminders/wording" />
          {mayIn(ctx.grants, lender.lenderId, 'manage') ? (
            <TemplateDraftForm lenderId={lender.lenderId} ctx={ctx} />
          ) : null}
          <Section title="Versions">
            <StatusFilter
              path="/reminders/wording"
              lenderId={lender.lenderId}
              query={query}
              extra={
                <>
                  <SelectInput
                    name="kind"
                    label="Show only this kind"
                    blank="All kinds"
                    options={options(LR_REMINDER_KINDS, reminderKindWords)}
                    defaultValue={query.kind}
                  />
                  <SelectInput
                    name="language"
                    label="Show only this language"
                    blank="All languages"
                    options={options(LR_TEMPLATE_LANGUAGES, languageWords)}
                    defaultValue={query.language}
                  />
                </>
              }
            />
            {!page.ok ? (
              <LoadFailure what="the wording" status={page.status} />
            ) : page.data.items.length === 0 ? (
              <EmptyList
                title="No wording yet"
                detail="No version has been drafted for this lender. A reminder is not sent without approved wording for its kind."
              />
            ) : (
              <>
                {page.data.items.map((template) => (
                  <TemplateCard key={template.id} template={template} ctx={ctx} />
                ))}
                <Paging
                  nextHref={
                    page.data.nextCursor
                      ? remindersHref('/reminders/wording', {
                          ...query,
                          lenderId: lender.lenderId,
                          cursor: page.data.nextCursor,
                        })
                      : null
                  }
                  firstHref={remindersHref('/reminders/wording', {
                    ...withoutCursor(query),
                    lenderId: lender.lenderId,
                  })}
                  hasCursor={query.cursor !== undefined}
                  noun="versions"
                />
              </>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The lender's penal-charge text
// ---------------------------------------------------------------------------------------------------------------
function PenalDraftForm({ lenderId, ctx }: { lenderId: string; ctx: RemindersContext }) {
  return (
    <Section title="Draft a penal-charge text">
      <p>
        This is your organisation’s own statement of the penal charge that applies when an
        instalment is overdue. Udofin does not suggest, translate or calculate any charge and shows
        the sentence in an overdue reminder exactly as approved. It is not a legal opinion, and this
        page does not say that it meets any rule. Another person must approve the draft before it is
        used.
      </p>
      <PenalDraftFields lenderId={lenderId} action={ctx.draft} returnTo={ctx.returnTo} />
    </Section>
  );
}

function PenalCard({ text, ctx }: { text: LrPenalText; ctx: RemindersContext }) {
  const titleId = idOf('penal', text.id);
  return (
    <article className="card" aria-labelledby={titleId}>
      <h3 id={titleId}>
        Version {formatCount(text.version)}: {artefactStatusShort(text.status)}
      </h3>
      <p className="muted">{artefactStatusWords(text.status)}</p>
      <dl className="facts">
        <div>
          <dt>Charge stated by the lender</dt>
          <dd>
            {chargeKindWords(text.chargeKind)}:{' '}
            {text.flatAmountMinor !== null
              ? formatRupees(text.flatAmountMinor)
              : text.percentBps !== null
                ? percentFromBps(text.percentBps)
                : 'No figure was stated'}{' '}
            of {chargeBasisWords(text.basis)}
          </dd>
        </div>
        <div>
          <dt>Stated by the lender: charged separately from interest</dt>
          <dd>{text.separateFromInterest ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt>Stated by the lender: not compounded</dt>
          <dd>{text.notCompounded ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt>Reason, as written</dt>
          <dd>{text.reason}</dd>
        </div>
        <div>
          <dt>Sentence shown to the borrower (English), as written</dt>
          <dd>{text.sentenceEn}</dd>
        </div>
        <div>
          <dt>Sentence shown to the borrower (Hindi), as written</dt>
          <dd>{text.sentenceHi === null ? 'No Hindi sentence' : text.sentenceHi}</dd>
        </div>
        <Trail
          userId={ctx.userId}
          draftedBy={text.draftedBy}
          draftedAt={text.draftedAt}
          approvedBy={text.approvedBy}
          approvedAt={text.approvedAt}
          retiredBy={text.retiredBy}
          retiredAt={text.retiredAt}
        />
      </dl>
      <VersionActions
        kind="penal"
        noun="penal-charge text"
        version={text}
        lenderId={text.lenderId}
        ctx={ctx}
        {...(text.status === 'approved'
          ? {
              retireWarning:
                'If this is the only approved penal-charge text, retiring it stops overdue reminders until another is approved.',
            }
          : {})}
      />
    </article>
  );
}

export function PenalTextPage({
  lender,
  page,
  query,
  ctx,
  done,
  error,
}: {
  lender: RemindersGrant | null;
  page: Loaded<LrPenalTextPage>;
  query: RemindersQuery;
  ctx: RemindersContext;
  done?: boolean;
  error?: string | undefined;
}) {
  const lenders = ctx.grants.filter(mayViewArtefacts);
  return (
    <div>
      <h1>Penal-charge text</h1>
      <RemindersNav current="/reminders/penal-text" />
      <RemindersNotice done={done} error={error} />
      {lender === null ? (
        <NoLender what="the penal-charge text" />
      ) : (
        <>
          <LenderPicker lenders={lenders} selected={lender.lenderId} path="/reminders/penal-text" />
          <OverdueNotice overdue={page.ok ? page.data.overdueReminders : null} />
          {mayIn(ctx.grants, lender.lenderId, 'manage') ? (
            <PenalDraftForm lenderId={lender.lenderId} ctx={ctx} />
          ) : null}
          <Section title="Versions">
            <StatusFilter path="/reminders/penal-text" lenderId={lender.lenderId} query={query} />
            {!page.ok ? (
              <LoadFailure what="the penal-charge text" status={page.status} />
            ) : page.data.items.length === 0 ? (
              <EmptyList
                title="No penal-charge text yet"
                detail="No version has been drafted for this lender."
              />
            ) : (
              <>
                {page.data.items.map((text) => (
                  <PenalCard key={text.id} text={text} ctx={ctx} />
                ))}
                <Paging
                  nextHref={
                    page.data.nextCursor
                      ? remindersHref('/reminders/penal-text', {
                          ...query,
                          lenderId: lender.lenderId,
                          cursor: page.data.nextCursor,
                        })
                      : null
                  }
                  firstHref={remindersHref('/reminders/penal-text', {
                    ...withoutCursor(query),
                    lenderId: lender.lenderId,
                  })}
                  hasCursor={query.cursor !== undefined}
                  noun="versions"
                />
              </>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------------------------------------------
export function HoldsPage({
  holds,
  query,
  ctx,
  done,
  error,
}: {
  holds: Loaded<LrHoldPage>;
  query: RemindersQuery;
  ctx: RemindersContext;
  done?: boolean;
  error?: string | undefined;
}) {
  const mayPlace = ctx.grants.some((g) => g.manage);
  const several = ctx.grants.length > 1;
  return (
    <div>
      <h1>Communication holds</h1>
      <RemindersNav current="/reminders/holds" />
      <p>A hold pauses reminders for one loan. A hold never stops the borrower from paying.</p>
      <RemindersNotice done={done} error={error} />
      {mayPlace ? (
        <Section title="Place a hold">
          <HoldPlaceFields action={ctx.draft} returnTo={ctx.returnTo} />
        </Section>
      ) : null}
      <Section title="Holds">
        <form method="get" action="/reminders/holds" className="inline">
          <SelectInput
            name="status"
            label="Status"
            blank="All holds"
            options={options(LR_HOLD_STATUSES, holdStatusWords)}
            defaultValue={query.status}
          />
          {several ? (
            <SelectInput
              name="lenderId"
              label="Lender"
              blank="All my lenders"
              options={ctx.grants.map((g) => ({ value: g.lenderId, label: g.name }))}
              defaultValue={query.lenderId}
            />
          ) : null}
          <TextInput
            name="loanAccountId"
            label="Loan ID (optional)"
            defaultValue={query.loanAccountId}
          />
          <button type="submit" className="secondary">
            Show
          </button>
        </form>
        {!holds.ok ? (
          <LoadFailure what="the holds" status={holds.status} />
        ) : holds.data.items.length === 0 ? (
          <EmptyList title="No holds" detail="No communication hold has been placed on a loan." />
        ) : (
          <>
            <table>
              <caption>Holds, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Loan</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Placed</th>
                  <th scope="col">Note, as written</th>
                  <th scope="col">Status</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {holds.data.items.map((hold) => (
                  <tr key={hold.id}>
                    <th scope="row">
                      <a href={`/loans/${hold.loanAccountId}`}>The loan</a>
                    </th>
                    <td>{holdReasonWords(hold.reason)}</td>
                    <td>
                      {formatIst(hold.placedAt)} by{' '}
                      <Person id={hold.placedBy} userId={ctx.userId} />
                    </td>
                    <td>{hold.note ?? '—'}</td>
                    <td>
                      {hold.active ? (
                        holdStatusWords('active')
                      ) : (
                        <>
                          {holdStatusWords('released')} {istOrDash(hold.releasedAt)}
                          {hold.releaseNote ? `: ${hold.releaseNote}` : ''}
                        </>
                      )}
                    </td>
                    <td>
                      {hold.active && mayIn(ctx.grants, hold.lenderId, 'manage') ? (
                        <OpForm
                          op="reminders.hold.release"
                          action={ctx.action}
                          returnTo={ctx.returnTo}
                          hidden={{ id: hold.id }}
                          submit="Release this hold"
                          secondary
                        >
                          <TextInput name="note" label="Release note (optional)" maxLength={1000} />
                        </OpForm>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Paging
              nextHref={
                holds.data.nextCursor
                  ? remindersHref('/reminders/holds', { ...query, cursor: holds.data.nextCursor })
                  : null
              }
              firstHref={remindersHref('/reminders/holds', withoutCursor(query))}
              hasCursor={query.cursor !== undefined}
              noun="holds"
            />
          </>
        )}
      </Section>
    </div>
  );
}
