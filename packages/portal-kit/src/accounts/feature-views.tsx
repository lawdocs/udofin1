import { AreaField, SelectField, TextField } from '../onboarding/forms.js';
import { EmptyList, LoadFailure, Paging } from '../servicing/common.js';
import { istOrDash } from '../servicing/format.js';
import {
  AccountsNotice,
  LenderField,
  PlatformForm,
  SecondPerson,
  Section,
  whoWords,
  type AccountsContext,
} from './common.js';
import { accountsHref, lenderLabel, withoutCursor, type AccountsQuery } from './data.js';
import { FEATURE_EVIDENCE_SLOTS } from './operations.js';
import {
  type CatalogueEntry,
  type ChangeRequest,
  type LenderChoice,
  type Loaded,
  type Page,
  type SwitchState,
} from './types.js';
import {
  featureWords,
  isLockedFeature,
  REQUEST_STATUSES,
  requestModeWords,
  requestStatusWords,
} from './wording.js';

interface Notice {
  done?: boolean | undefined;
  error?: string | undefined;
  result?: string | undefined;
  reasons?: string | undefined;
}

/** A feature that cannot be switched on in this release: by the catalogue, or by the screen’s own second list. */
export const isFeatureLocked = (entry: CatalogueEntry): boolean =>
  !entry.enableable || isLockedFeature(entry.feature);

function LockedNote({ entry }: { entry: CatalogueEntry }) {
  return (
    <>
      <p>
        <strong>Not available in this release.</strong> This switch cannot be enabled.
      </p>
      {entry.lockedReason ? (
        <p className="muted">As the catalogue records it: {entry.lockedReason}</p>
      ) : null}
    </>
  );
}

function EvidenceSlots() {
  const slots = Array.from({ length: FEATURE_EVIDENCE_SLOTS }, (_, i) => i + 1);
  return (
    <fieldset>
      <legend>Evidence you checked</legend>
      <p className="muted">
        Give a short name (lower-case letters, digits and underscores) and a reference for each
        thing you checked, such as the title of a document. At least one is needed to switch
        something on. Do not type account, phone or identity numbers.
      </p>
      {slots.map((slot) => (
        <div key={slot} className="inline">
          <TextField name={`evidenceLabel${String(slot)}`} label={`Name ${String(slot)}`} />
          <TextField name={`evidenceValue${String(slot)}`} label={`Reference ${String(slot)}`} />
        </div>
      ))}
    </fieldset>
  );
}

function SwitchCard({
  entry,
  state,
  lenderId,
  pending,
  ctx,
}: {
  entry: CatalogueEntry;
  state: SwitchState | undefined;
  lenderId: string;
  pending: boolean;
  ctx: AccountsContext;
}) {
  const locked = isFeatureLocked(entry);
  const enabled = state?.enabled === true;
  return (
    <article className="card">
      <h3>{featureWords(entry.feature)}</h3>
      <p>{entry.description}</p>
      {locked ? (
        <LockedNote entry={entry} />
      ) : (
        <>
          <p>
            <strong>{enabled ? 'On' : 'Off'}</strong>
            {enabled && state?.enabledAt ? ` since ${istOrDash(state.enabledAt)}` : ''}
            {!enabled && state?.disabledAt ? ` since ${istOrDash(state.disabledAt)}` : ''}
            {state === undefined ? ': it has never been switched on for this lender' : ''}
          </p>
          {pending ? (
            <p role="status">A request for this switch is waiting for a decision (see below).</p>
          ) : null}
          {ctx.caps.featuresManage && !enabled && !pending ? (
            <details>
              <summary>Ask to switch this on</summary>
              <PlatformForm
                op="feature.request"
                action={ctx.action}
                returnTo={ctx.returnTo}
                hidden={{ lenderId, feature: entry.feature, direction: 'on' }}
              >
                <p>
                  A different person decides the request. If the lender does not yet meet what the
                  switch needs, the request is refused and the reasons are listed in plain words.
                </p>
                <EvidenceSlots />
                <AreaField
                  name="reason"
                  label="Reason (optional)"
                  hint="10 to 1000 characters if given."
                />
                <button type="submit">Send the request</button>
              </PlatformForm>
            </details>
          ) : null}
          {ctx.caps.featuresManage && enabled ? (
            <>
              {!pending ? (
                <details>
                  <summary>Ask to switch this off (a different person decides)</summary>
                  <PlatformForm
                    op="feature.request"
                    action={ctx.action}
                    returnTo={ctx.returnTo}
                    hidden={{ lenderId, feature: entry.feature, direction: 'off' }}
                  >
                    <AreaField
                      name="reason"
                      label="Reason"
                      required
                      hint="At least 10 characters. Do not type account, phone or identity numbers."
                    />
                    <button type="submit">Send the request</button>
                  </PlatformForm>
                </details>
              ) : null}
              <details>
                <summary>Emergency switch-off (one person, takes effect now)</summary>
                <PlatformForm
                  op="feature.kill"
                  action={ctx.action}
                  returnTo={ctx.returnTo}
                  hidden={{ lenderId, feature: entry.feature }}
                >
                  <p>
                    This switches {featureWords(entry.feature).toLowerCase()} off for this lender
                    straight away, without a second person. It can only switch off; switching it on
                    again needs a two-person request.
                  </p>
                  <AreaField
                    name="reason"
                    label="Reason"
                    required
                    hint="At least 10 characters. Do not type account, phone or identity numbers."
                  />
                  <div className="field">
                    <label>
                      <input type="checkbox" name="confirm" required /> I confirm that I am
                      switching this off now, on my own decision.
                    </label>
                  </div>
                  <button type="submit">Switch off now</button>
                </PlatformForm>
              </details>
            </>
          ) : null}
          {!ctx.caps.featuresManage ? (
            <p className="muted">Your role cannot change feature switches.</p>
          ) : null}
        </>
      )}
    </article>
  );
}

function RequestCard({
  request,
  ctx,
  lenders,
}: {
  request: ChangeRequest;
  ctx: AccountsContext;
  lenders: readonly LenderChoice[] | null;
}) {
  const own = request.requestedBy === ctx.userId;
  const evidence = Object.entries(request.evidence);
  return (
    <article className="card">
      <h3>
        {featureWords(request.feature)}: {request.enable ? 'switch on' : 'switch off'} for{' '}
        {lenderLabel(lenders, request.lenderId)}
      </h3>
      <dl className="facts">
        <div>
          <dt>Status</dt>
          <dd>{requestStatusWords(request.status)}</dd>
        </div>
        <div>
          <dt>How</dt>
          <dd>{requestModeWords(request.mode)}</dd>
        </div>
        <div>
          <dt>Requested</dt>
          <dd>
            {istOrDash(request.requestedAt)} by {whoWords(request.requestedBy, ctx.userId)}
          </dd>
        </div>
        {request.status === 'pending' ? (
          <div>
            <dt>Runs out</dt>
            <dd>{istOrDash(request.expiresAt)}</dd>
          </div>
        ) : null}
        {request.reason ? (
          <div>
            <dt>Reason</dt>
            <dd>{request.reason}</dd>
          </div>
        ) : null}
        {evidence.length > 0 ? (
          <div>
            <dt>Evidence</dt>
            <dd>
              <ul>
                {evidence.map(([name, value]) => (
                  <li key={name}>
                    {name.replaceAll('_', ' ')}: {value}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
        {request.decidedAt ? (
          <div>
            <dt>Decided</dt>
            <dd>
              {istOrDash(request.decidedAt)} by {whoWords(request.decidedBy, ctx.userId)}
              {request.decisionNote ? `. Note: ${request.decisionNote}` : ''}
            </dd>
          </div>
        ) : null}
        {request.appliedAt ? (
          <div>
            <dt>Applied</dt>
            <dd>{istOrDash(request.appliedAt)}</dd>
          </div>
        ) : null}
      </dl>
      {request.status === 'pending' && ctx.caps.featuresManage ? (
        own ? (
          <>
            <SecondPerson>
              You made this request, so a different person must decide it. You can cancel it.
            </SecondPerson>
            <PlatformForm
              op="feature.cancel"
              action={ctx.action}
              returnTo={ctx.returnTo}
              hidden={{ id: request.id }}
            >
              <button type="submit" className="secondary">
                Cancel the request
              </button>
            </PlatformForm>
          </>
        ) : (
          <PlatformForm
            op="feature.decide"
            action={ctx.action}
            returnTo={ctx.returnTo}
            hidden={{ id: request.id }}
          >
            <AreaField
              name="note"
              label="Note"
              hint="Required when you reject (at least 10 characters). Optional when you approve."
            />
            <div className="inline">
              <button type="submit" name="verdict" value="approve">
                Approve the request
              </button>
              <button type="submit" name="verdict" value="reject" className="secondary">
                Reject the request
              </button>
            </div>
          </PlatformForm>
        )
      ) : null}
    </article>
  );
}

export function FeaturesPage({
  catalogue,
  lenderId,
  switches,
  requests,
  lenders,
  query,
  ctx,
  notice,
}: {
  catalogue: Loaded<{ items: CatalogueEntry[] }>;
  /** The lender whose switches are shown, if one was chosen. */
  lenderId?: string | undefined;
  switches: Loaded<{ items: SwitchState[] }> | null;
  requests: Loaded<Page<ChangeRequest>>;
  lenders: readonly LenderChoice[] | null;
  query: AccountsQuery;
  ctx: AccountsContext;
  notice: Notice;
}) {
  const pendingFor = (feature: string) =>
    requests.ok &&
    requests.data.items.some(
      (r) => r.status === 'pending' && r.feature === feature && r.lenderId === lenderId,
    );
  return (
    <div>
      <h1>Feature switches</h1>
      <p>
        Each lender has its own switches. Changing one needs a request with evidence and a decision
        by a different person. Nothing is switched on for you, and a switch that is off never
        deletes history.
      </p>
      <AccountsNotice {...notice} />

      <Section title="Choose a lender">
        <form method="get" action="/features" className="inline">
          <LenderField
            name="lenderId"
            label="Lender"
            lenders={lenders}
            defaultValue={lenderId}
            required
          />
          <button type="submit" className="secondary">
            Show the switches
          </button>
        </form>
        <p className="muted">
          A lender that does not exist looks the same here as a lender with every switch off.
        </p>
      </Section>

      <Section
        title={lenderId ? `Switches for ${lenderLabel(lenders, lenderId)}` : 'What can be switched'}
      >
        {!catalogue.ok ? (
          <LoadFailure what="the feature catalogue" status={catalogue.status} />
        ) : catalogue.data.items.length === 0 ? (
          <EmptyList title="No features" detail="The catalogue is empty." />
        ) : lenderId === undefined ? (
          catalogue.data.items.map((entry) => (
            <article key={entry.feature} className="card">
              <h3>{featureWords(entry.feature)}</h3>
              <p>{entry.description}</p>
              {isFeatureLocked(entry) ? <LockedNote entry={entry} /> : null}
            </article>
          ))
        ) : !switches ? null : !switches.ok ? (
          <LoadFailure what="the switches of this lender" status={switches.status} />
        ) : (
          catalogue.data.items.map((entry) => (
            <SwitchCard
              key={entry.feature}
              entry={entry}
              state={switches.data.items.find((s) => s.feature === entry.feature)}
              lenderId={lenderId}
              pending={pendingFor(entry.feature)}
              ctx={ctx}
            />
          ))
        )}
      </Section>

      <Section title="Requests">
        <form method="get" action="/features" className="inline">
          <SelectField
            name="status"
            label="Status"
            blank="All"
            options={REQUEST_STATUSES.map((value) => ({ value, label: requestStatusWords(value) }))}
            defaultValue={query.status ?? ''}
          />
          <input type="hidden" name="lenderId" value={lenderId ?? ''} />
          <button type="submit" className="secondary">
            Show
          </button>
        </form>
        {!requests.ok ? (
          <LoadFailure what="the requests" status={requests.status} />
        ) : requests.data.items.length === 0 ? (
          <EmptyList title="No requests" detail="Nothing matches this filter." />
        ) : (
          <>
            {requests.data.items.map((request) => (
              <RequestCard key={request.id} request={request} ctx={ctx} lenders={lenders} />
            ))}
            <Paging
              nextHref={
                requests.data.nextCursor
                  ? accountsHref('/features', { ...query, cursor: requests.data.nextCursor })
                  : null
              }
              firstHref={accountsHref('/features', withoutCursor(query))}
              hasCursor={query.cursor !== undefined}
              noun="requests"
            />
          </>
        )}
      </Section>
    </div>
  );
}
