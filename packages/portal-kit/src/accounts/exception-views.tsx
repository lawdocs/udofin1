import { LP_REOPEN_REASONS, LP_RESOLVE_REASONS } from '@udofin/contracts';
import { AreaField, SelectField, TextField } from '../onboarding/forms.js';
import { EmptyList, LoadFailure, Paging } from '../servicing/common.js';
import { istOrDash } from '../servicing/format.js';
import {
  AccountsNotice,
  PlatformForm,
  SecondPerson,
  Section,
  whoWords,
  type AccountsContext,
} from './common.js';
import { accountsHref, lenderLabel, withoutCursor, type AccountsQuery } from './data.js';
import { EXCEPTION_EVIDENCE_SLOTS } from './operations.js';
import {
  type ExceptionDetail,
  type LenderChoice,
  type Loaded,
  type Page,
  type PlatformException,
} from './types.js';
import {
  actorKindWords,
  exceptionActionWords,
  exceptionClassWords,
  exceptionSeverityWords,
  EXCEPTION_SEVERITIES,
  exceptionStatusWords,
  reasonWords,
  resolveReasonWords,
} from './wording.js';

interface Notice {
  done?: boolean | undefined;
  error?: string | undefined;
  result?: string | undefined;
  reasons?: string | undefined;
}

const KEY_SHAPE = /^[a-z][a-z0-9_]{1,40}$/;
const VALUE_SHAPE = /^[A-Za-z0-9._:/#-]{1,100}$/;

/**
 * The subject of an exception holds identifiers only. A pair that does not look like an identifier is not printed: the screen
 * says how many were left out instead of repeating them.
 */
export function SubjectList({ subject }: { subject: Readonly<Record<string, string>> }) {
  const entries = Object.entries(subject);
  const shown = entries.filter(([key, value]) => KEY_SHAPE.test(key) && VALUE_SHAPE.test(value));
  const hidden = entries.length - shown.length;
  if (entries.length === 0) return <p className="muted">No identifiers were recorded.</p>;
  return (
    <>
      <ul>
        {shown.map(([key, value]) => (
          <li key={key}>
            {key.replaceAll('_', ' ')}: {value}
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <p className="muted">{`${String(hidden)} recorded ${hidden === 1 ? 'value is' : 'values are'} not shown because ${hidden === 1 ? 'it does' : 'they do'} not look like an identifier.`}</p>
      ) : null}
    </>
  );
}

function assignedWords(assignedTo: string | null, userId: string): string {
  if (assignedTo === null) return 'Not assigned';
  return assignedTo === userId ? 'Assigned to you' : 'Assigned to another member of staff';
}

function ActionForms({ item, ctx }: { item: PlatformException; ctx: AccountsContext }) {
  // Only an exception that Udofin owns is worked here. A lender-owned one is worked by the lender; staff can read it, not act.
  if (item.owner !== 'platform')
    return <p className="muted">This exception is worked by the lender. You can read it here.</p>;
  if (!ctx.caps.providersManage)
    return <SecondPerson>Your role cannot work exceptions.</SecondPerson>;
  const resolved = item.status === 'resolved';
  const slots = Array.from({ length: EXCEPTION_EVIDENCE_SLOTS }, (_, i) => i + 1);
  return (
    <>
      {item.status === 'open' || item.status === 'reopened' ? (
        <PlatformForm
          op="exception.acknowledge"
          action={ctx.action}
          returnTo={ctx.returnTo}
          hidden={{ id: item.id }}
        >
          <button type="submit">Acknowledge: I have seen this</button>
        </PlatformForm>
      ) : null}
      {!resolved ? (
        <>
          <details>
            <summary>Assign</summary>
            <PlatformForm
              op="exception.assign"
              action={ctx.action}
              returnTo={ctx.returnTo}
              hidden={{ id: item.id }}
            >
              <TextField
                name="assignee"
                label="Identifier of the person to assign to"
                required
                defaultValue={ctx.userId}
                hint="This is your own identifier. Replace it to assign a colleague."
              />
              <button type="submit">Assign</button>
            </PlatformForm>
          </details>
          <details>
            <summary>Resolve</summary>
            <PlatformForm
              op="exception.resolve"
              action={ctx.action}
              returnTo={ctx.returnTo}
              hidden={{ id: item.id }}
            >
              <p>
                Resolving records what you did and changes nothing else: it does not move money or
                alter a payment.
              </p>
              <SelectField
                name="reasonCode"
                label="Why it is resolved"
                blank="Choose"
                required
                options={LP_RESOLVE_REASONS.map((value) => ({
                  value,
                  label: resolveReasonWords(value),
                }))}
              />
              {slots.map((slot) => (
                <TextField
                  key={slot}
                  name={`evidence${String(slot)}`}
                  label={`Reference to what you checked (${String(slot)})`}
                  {...(slot === 1 ? { required: true } : {})}
                  hint={
                    slot === 1
                      ? 'Letters, digits and . _ : / # - only, no spaces, up to 100 characters.'
                      : 'Optional.'
                  }
                />
              ))}
              <AreaField
                name="note"
                label="Note (optional)"
                hint="Up to 500 characters. Do not type names, account, phone or identity numbers."
              />
              <button type="submit">Resolve the exception</button>
            </PlatformForm>
          </details>
        </>
      ) : (
        <details>
          <summary>Reopen</summary>
          <PlatformForm
            op="exception.reopen"
            action={ctx.action}
            returnTo={ctx.returnTo}
            hidden={{ id: item.id }}
          >
            <SelectField
              name="reasonCode"
              label="Why it is reopened"
              blank="Choose"
              required
              options={LP_REOPEN_REASONS.map((value) => ({
                value,
                label: resolveReasonWords(value),
              }))}
            />
            <AreaField
              name="note"
              label="Note (optional)"
              hint="Up to 500 characters. Do not type names, account, phone or identity numbers."
            />
            <button type="submit">Reopen the exception</button>
          </PlatformForm>
        </details>
      )}
    </>
  );
}

function ExceptionCard({
  item,
  ctx,
  lenders,
}: {
  item: PlatformException;
  ctx: AccountsContext;
  lenders: readonly LenderChoice[] | null;
}) {
  return (
    <article className="card">
      <h3>{exceptionClassWords(item.class)}</h3>
      <dl className="facts">
        <div>
          <dt>Severity</dt>
          <dd>{exceptionSeverityWords(item.severity)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{exceptionStatusWords(item.status)}</dd>
        </div>
        <div>
          <dt>Lender</dt>
          <dd>{lenderLabel(lenders, item.lenderId)}</dd>
        </div>
        <div>
          <dt>Worked by</dt>
          <dd>{item.owner === 'platform' ? 'Udofin staff' : 'The lender'}</dd>
        </div>
        <div>
          <dt>Assigned</dt>
          <dd>{assignedWords(item.assignedTo, ctx.userId)}</dd>
        </div>
        <div>
          <dt>Opened</dt>
          <dd>{istOrDash(item.openedAt)}</dd>
        </div>
        {item.resolvedAt ? (
          <div>
            <dt>Resolved</dt>
            <dd>{istOrDash(item.resolvedAt)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Identifiers</dt>
          <dd>
            <SubjectList subject={item.subject} />
          </dd>
        </div>
      </dl>
      <p>
        <a href={`/exceptions/${item.id}`}>Open the history</a>
      </p>
      <ActionForms item={item} ctx={ctx} />
    </article>
  );
}

export function ExceptionsPage({
  open,
  resolved,
  view,
  lenders,
  query,
  ctx,
  notice,
}: {
  open: Loaded<Page<PlatformException>>;
  /** Loaded only when the resolved view is chosen. */
  resolved: Loaded<Page<PlatformException>> | null;
  view: 'open' | 'resolved';
  lenders: readonly LenderChoice[] | null;
  query: AccountsQuery;
  ctx: AccountsContext;
  notice: Notice;
}) {
  const shown = view === 'resolved' ? resolved : open;
  const base = '/exceptions';
  return (
    <div>
      <h1>Platform exceptions</h1>
      <p>
        Exceptions that Udofin staff own, such as a merchant that differs from the one configured, a
        provider message that arrived twice with different content, or a settlement reported for an
        account that is not the lender’s linked account. A lender’s own exceptions are worked by the
        lender.
      </p>
      <nav aria-label="Exception views" className="tabs">
        <ul>
          <li>
            <a
              href={accountsHref(base, { ...withoutCursor(query), view: 'open' })}
              aria-current={view === 'open' ? 'page' : undefined}
            >
              Not resolved
            </a>
          </li>
          <li>
            <a
              href={accountsHref(base, { ...withoutCursor(query), view: 'resolved' })}
              aria-current={view === 'resolved' ? 'page' : undefined}
            >
              Resolved
            </a>
          </li>
        </ul>
      </nav>
      <AccountsNotice {...notice} />
      <form method="get" action={base} className="inline">
        <input type="hidden" name="view" value={view} />
        <SelectField
          name="severity"
          label="Severity"
          blank="All"
          options={EXCEPTION_SEVERITIES.map((value) => ({
            value,
            label: exceptionSeverityWords(value),
          }))}
          defaultValue={query.severity ?? ''}
        />
        <button type="submit" className="secondary">
          Show
        </button>
      </form>
      <Section title={view === 'resolved' ? 'Resolved exceptions' : 'Exceptions not resolved'}>
        {!shown ? null : !shown.ok ? (
          <LoadFailure what="the exceptions" status={shown.status} />
        ) : shown.data.items.length === 0 ? (
          <EmptyList
            title={view === 'resolved' ? 'Nothing resolved' : 'No open exceptions'}
            detail="Nothing matches this filter."
          />
        ) : (
          <>
            {shown.data.items.map((item) => (
              <ExceptionCard key={item.id} item={item} ctx={ctx} lenders={lenders} />
            ))}
            <Paging
              nextHref={
                shown.data.nextCursor
                  ? accountsHref(base, { ...query, view, cursor: shown.data.nextCursor })
                  : null
              }
              firstHref={accountsHref(base, { ...withoutCursor(query), view })}
              hasCursor={query.cursor !== undefined}
              noun="exceptions"
            />
          </>
        )}
      </Section>
    </div>
  );
}

const EVIDENCE_ITEM = /^[A-Za-z0-9._:/#-]{1,100}$/;

export function ExceptionDetailPage({
  detail,
  lenders,
  ctx,
  notice,
}: {
  detail: Loaded<ExceptionDetail>;
  lenders: readonly LenderChoice[] | null;
  ctx: AccountsContext;
  notice: Notice;
}) {
  return (
    <div>
      <h1>Exception history</h1>
      <p>
        <a href="/exceptions">Back to the exceptions</a>
      </p>
      <AccountsNotice {...notice} />
      {!detail.ok ? (
        <LoadFailure what="this exception" status={detail.status} />
      ) : (
        <>
          <ExceptionCard item={detail.data.exception} ctx={ctx} lenders={lenders} />
          <Section title="What happened">
            <ol>
              {detail.data.events.map((event) => {
                const why = reasonWords(event.reasonCode);
                const evidence = (event.evidence ?? []).filter((e) => EVIDENCE_ITEM.test(e));
                return (
                  <li key={event.id}>
                    <p>
                      <strong>{exceptionActionWords(event.action)}</strong> on{' '}
                      {istOrDash(event.occurredAt)} by {actorKindWords(event.actorKind)}
                      {event.actorUserId ? ` (${whoWords(event.actorUserId, ctx.userId)})` : ''}.
                    </p>
                    {why ? <p>Reason: {why}.</p> : null}
                    {event.assignedTo ? (
                      <p>{`Assigned to ${whoWords(event.assignedTo, ctx.userId)}.`}</p>
                    ) : null}
                    {evidence.length > 0 ? <p>Evidence: {evidence.join(', ')}.</p> : null}
                    {event.note ? <p>Note written by staff: {event.note}</p> : null}
                  </li>
                );
              })}
            </ol>
          </Section>
        </>
      )}
    </div>
  );
}
