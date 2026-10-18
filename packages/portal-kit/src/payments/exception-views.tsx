import {
  LP_EXCEPTION_OWNERS,
  LP_EXCEPTION_SEVERITIES,
  LP_EXCEPTION_STATUSES,
  LP_REOPEN_REASONS,
  LP_RESOLVE_REASONS,
} from '@udofin/contracts';
import { AreaField, OpForm, SelectField, TextField } from '../onboarding/forms.js';
import { EmptyState } from '../states.js';
import { type LpResult } from './data.js';
import { lpCount, lpDateTimeIst } from './format.js';
import {
  EXCEPTION_ACTION_WORDS,
  EXCEPTION_ACTOR_WORDS,
  EXCEPTION_CLASS_WORDS,
  EXCEPTION_OWNER_WORDS,
  EXCEPTION_SEVERITY_WORDS,
  EXCEPTION_STATUS_WORDS,
  EXCEPTION_SUBJECT_WORDS,
  RESOLVE_REASON_WORDS,
  lpWord,
} from './labels.js';
import {
  ConfirmField,
  CriticalBanner,
  Facts,
  Loadable,
  Pager,
  LpNotice,
  RECONCILIATION_LINKS,
  SectionNav,
  type LpViewContext,
} from './parts.js';
import { type ExceptionDetail, type ExceptionPage, type ExceptionRow } from './types.js';

const options = (values: readonly string[], words: (value: string) => string) =>
  values.map((value) => ({ value, label: words(value) }));

/** A person is named only as "you" or by the end of their id: the portal has no directory of names. */
function assignee(id: string | null, userId: string | undefined): string {
  if (id === null) return 'Nobody yet';
  if (userId !== undefined && id === userId) return 'You';
  return `Another person (id ending ${id.slice(-8)})`;
}

const ownerWords = (owner: string) => lpWord(EXCEPTION_OWNER_WORDS, owner);

// ---------------------------------------------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------------------------------------------
export function LpExceptionsQueueView({
  page,
  filters,
  keep,
  userId,
}: {
  page: LpResult<ExceptionPage> | undefined;
  filters: {
    status?: string | undefined;
    severity?: string | undefined;
    owner?: string | undefined;
    class?: string | undefined;
  };
  keep: Readonly<Record<string, string>>;
  userId?: string | undefined;
}) {
  return (
    <section>
      <h1>Exceptions</h1>
      <SectionNav
        links={RECONCILIATION_LINKS}
        current="/reconciliation/exceptions"
        label="Reconciliation"
      />
      <p className="muted">
        Things the platform noticed that a person must look at. Resolving an exception records your
        reason and evidence only: it moves no money and changes no payment, mandate or settlement
        stage. Exceptions that Udofin platform staff handle are marked; you can read them but not
        act on them.
      </p>
      <form method="get" action="/reconciliation/exceptions" className="form">
        <SelectField
          name="status"
          label="Status"
          blank="All statuses"
          defaultValue={filters.status ?? ''}
          options={options(LP_EXCEPTION_STATUSES, (v) => lpWord(EXCEPTION_STATUS_WORDS, v))}
        />
        <SelectField
          name="severity"
          label="Severity"
          blank="All severities"
          defaultValue={filters.severity ?? ''}
          options={options(LP_EXCEPTION_SEVERITIES, (v) => lpWord(EXCEPTION_SEVERITY_WORDS, v))}
        />
        <SelectField
          name="owner"
          label="Handled by"
          blank="Anyone"
          defaultValue={filters.owner ?? ''}
          options={options(LP_EXCEPTION_OWNERS, ownerWords)}
        />
        <SelectField
          name="class"
          label="Kind"
          blank="All kinds"
          defaultValue={filters.class ?? ''}
          options={options(Object.keys(EXCEPTION_CLASS_WORDS), (v) =>
            lpWord(EXCEPTION_CLASS_WORDS, v),
          )}
        />
        <button type="submit">Apply filters</button>
      </form>
      <Loadable result={page} title="the exceptions">
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState
              title="No exceptions to show"
              detail="No exception matches these filters."
            />
          ) : (
            <>
              <table>
                <caption className="sr-only">Exceptions, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Opened</th>
                    <th scope="col">What happened</th>
                    <th scope="col">Severity</th>
                    <th scope="col">Handled by</th>
                    <th scope="col">Status</th>
                    <th scope="col">Assigned to</th>
                    <th scope="col">
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => (
                    <tr key={row.id}>
                      <td>{lpDateTimeIst(row.openedAt)}</td>
                      <td>{lpWord(EXCEPTION_CLASS_WORDS, row.class)}</td>
                      <td>{lpWord(EXCEPTION_SEVERITY_WORDS, row.severity)}</td>
                      <td>{ownerWords(row.owner)}</td>
                      <td>{lpWord(EXCEPTION_STATUS_WORDS, row.status)}</td>
                      <td>{assignee(row.assignedTo, userId)}</td>
                      <td>
                        <a href={`/reconciliation/exceptions/${row.id}`}>Open</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager
                basePath="/reconciliation/exceptions"
                keep={keep}
                nextCursor={data.nextCursor}
              />
            </>
          )
        }
      </Loadable>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Detail and the four actions
// ---------------------------------------------------------------------------------------------------------------
const SUBJECT_LINKS: Readonly<Record<string, (id: string) => string>> = {
  intent_id: (id) => `/payments/${encodeURIComponent(id)}`,
  mandate_id: (id) => `/mandates/${encodeURIComponent(id)}`,
  settlement_batch_id: (id) => `/reconciliation/settlements/${encodeURIComponent(id)}`,
};

function Subject({ subject }: { subject: ExceptionRow['subject'] }) {
  const entries = Object.entries(subject);
  if (entries.length === 0) return <p>No reference is recorded.</p>;
  return (
    <ul>
      {entries.map(([key, value]) => {
        const link = Object.hasOwn(SUBJECT_LINKS, key) ? SUBJECT_LINKS[key]?.(value) : undefined;
        return (
          <li key={key}>
            {lpWord(EXCEPTION_SUBJECT_WORDS, key)}: {link ? <a href={link}>{value}</a> : value}
          </li>
        );
      })}
    </ul>
  );
}

function Actions({ exception, ctx }: { exception: ExceptionRow; ctx: LpViewContext }) {
  if (exception.owner === 'platform') {
    return (
      <p>
        This exception is <strong>handled by Udofin platform staff</strong>. You can read it, but
        only they can act on it.
      </p>
    );
  }
  if (!ctx.caps.reconcile) {
    return (
      <p className="muted">
        You can read this exception, but your role does not include acting on it.
      </p>
    );
  }
  const id = exception.id;
  const open = exception.status === 'open' || exception.status === 'reopened';
  const resolved = exception.status === 'resolved';
  return (
    <>
      {open ? (
        <OpForm
          op="payments.exception.acknowledge"
          action={ctx.action}
          returnTo={ctx.returnTo}
          hidden={{ id }}
          submit="Acknowledge"
        >
          <p className="muted">
            Acknowledging says that someone has seen it. It changes nothing else.
          </p>
          <ConfirmField label="I confirm that I want to acknowledge this exception." />
        </OpForm>
      ) : null}
      {!resolved ? (
        <>
          {ctx.userId ? (
            <OpForm
              op="payments.exception.assign"
              action={ctx.action}
              returnTo={ctx.returnTo}
              hidden={{ id, assignee: ctx.userId }}
              submit="Assign to me"
              secondary
            >
              <ConfirmField label="I confirm that I want to take this exception." />
            </OpForm>
          ) : null}
          <OpForm
            op="payments.exception.assign"
            action={ctx.action}
            returnTo={ctx.returnTo}
            hidden={{ id }}
            submit="Assign to a colleague"
            secondary
          >
            <TextField
              name="assignee"
              required
              label="Your colleague’s user id"
              hint="The person must hold the reconciliation permission of your organisation; the server refuses anyone else."
            />
            <ConfirmField label="I confirm that I want to assign this exception to this person." />
          </OpForm>
          <OpForm
            op="payments.exception.resolve"
            action={ctx.action}
            returnTo={ctx.returnTo}
            hidden={{ id }}
            submit="Resolve"
          >
            <p className="muted">
              Resolving records your reason and the evidence you reviewed. It does not move money,
              change a payment, a mandate or a settlement stage, or contact anyone. If money has to
              move, that is done by your organisation or the provider, outside this portal.
            </p>
            <SelectField
              name="reasonCode"
              label="Reason"
              blank="Choose a reason"
              required
              options={options(LP_RESOLVE_REASONS, (v) => lpWord(RESOLVE_REASON_WORDS, v))}
            />
            <AreaField
              name="evidence"
              required
              label="Evidence you reviewed (references, one to ten)"
              hint="Short references such as ids or document labels. Letters, digits and . _ : / # - only, no spaces. Separate them with a space, a comma or a new line."
            />
            <AreaField
              name="note"
              label="Note (optional, at most 500 characters)"
              hint="Do not put names, phone numbers, account numbers or other personal data in the note. It is shown to the people at your organisation who read this exception and Udofin does not check it."
            />
            <ConfirmField label="I confirm that I reviewed the evidence and want to resolve this exception." />
          </OpForm>
        </>
      ) : (
        <OpForm
          op="payments.exception.reopen"
          action={ctx.action}
          returnTo={ctx.returnTo}
          hidden={{ id }}
          submit="Reopen"
        >
          <SelectField
            name="reasonCode"
            label="Reason for reopening"
            blank="Choose a reason"
            required
            options={options(LP_REOPEN_REASONS, (v) => lpWord(RESOLVE_REASON_WORDS, v))}
          />
          <AreaField
            name="note"
            label="Note (optional, at most 500 characters)"
            hint="Do not put names, phone numbers, account numbers or other personal data in the note."
          />
          <ConfirmField label="I confirm that I want to reopen this exception." />
        </OpForm>
      )}
    </>
  );
}

export function LpExceptionDetailView({
  detail,
  ctx,
  done,
  error,
}: {
  detail: LpResult<ExceptionDetail> | undefined;
  ctx: LpViewContext;
  done?: boolean;
  error?: string | undefined;
}) {
  return (
    <section>
      <h1>Exception</h1>
      <SectionNav
        links={RECONCILIATION_LINKS}
        current="/reconciliation/exceptions"
        label="Reconciliation"
      />
      <LpNotice done={done} error={error} />
      <Loadable result={detail} title="this exception">
        {(data) => {
          const exception = data.exception;
          return (
            <>
              {exception.severity === 'critical' && exception.status !== 'resolved' ? (
                <CriticalBanner title={lpWord(EXCEPTION_CLASS_WORDS, exception.class)}>
                  <p>This exception is critical and is not resolved.</p>
                </CriticalBanner>
              ) : null}
              <Facts
                rows={[
                  ['What happened', lpWord(EXCEPTION_CLASS_WORDS, exception.class)],
                  ['Severity', lpWord(EXCEPTION_SEVERITY_WORDS, exception.severity)],
                  ['Handled by', ownerWords(exception.owner)],
                  ['Status', lpWord(EXCEPTION_STATUS_WORDS, exception.status)],
                  ['Assigned to', assignee(exception.assignedTo, ctx.userId)],
                  ['Opened', lpDateTimeIst(exception.openedAt)],
                  [
                    'Resolved',
                    exception.resolvedAt ? lpDateTimeIst(exception.resolvedAt) : 'Not resolved',
                  ],
                  ['Last changed', lpDateTimeIst(exception.updatedAt)],
                ]}
              />
              <h2>What it refers to</h2>
              <Subject subject={exception.subject} />
              <h2>Actions</h2>
              <Actions exception={exception} ctx={ctx} />
              <h2>History</h2>
              <p className="muted">
                Every step as recorded, with who took it. Notes are written by people and are not
                checked by Udofin.
              </p>
              {data.events.length === 0 ? (
                <p>No step is recorded yet.</p>
              ) : (
                <table>
                  <caption className="sr-only">History of this exception</caption>
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Step</th>
                      <th scope="col">By</th>
                      <th scope="col">Reason</th>
                      <th scope="col">Evidence</th>
                      <th scope="col">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.events.map((event) => (
                      <tr key={event.id}>
                        <td>{lpDateTimeIst(event.occurredAt)}</td>
                        <td>
                          {lpWord(EXCEPTION_ACTION_WORDS, event.action)}
                          {event.assignedTo
                            ? ` to ${assignee(event.assignedTo, ctx.userId).toLowerCase()}`
                            : ''}
                        </td>
                        <td>{lpWord(EXCEPTION_ACTOR_WORDS, event.actorKind)}</td>
                        <td>
                          {event.reasonCode ? lpWord(RESOLVE_REASON_WORDS, event.reasonCode) : '—'}
                        </td>
                        <td>{event.evidence ? event.evidence.join(', ') : '—'}</td>
                        <td>{event.note ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {data.events.length >= 500 ? (
                <p className="muted">At most {lpCount(500)} steps are shown.</p>
              ) : null}
            </>
          );
        }}
      </Loadable>
    </section>
  );
}
