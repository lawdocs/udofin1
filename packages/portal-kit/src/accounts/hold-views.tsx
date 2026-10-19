import { TextArea } from '../reminders/fields.js';
import { EmptyList, LoadFailure, Paging } from '../servicing/common.js';
import { formatIst, istOrDash } from '../servicing/format.js';
import {
  AccountsNotice,
  LenderField,
  PlatformForm,
  ProvidersNav,
  SecondPerson,
  type AccountsContext,
} from './common.js';
import {
  accountsHref,
  lenderLabel,
  mayReleaseHold,
  withoutCursor,
  type AccountsQuery,
} from './data.js';
import { type ConfigEntry, type LenderChoice, type Loaded, type Page } from './types.js';
import {
  holdKindWords,
  paymentConfigModeWords,
  paymentConfigReasonWords,
  paymentConfigStatusWords,
  RELEASE_REASON_MAX,
  RELEASE_REASON_MIN,
  releaseRuleWords,
} from './wording.js';

interface Notice {
  done?: boolean | undefined;
  error?: string | undefined;
  result?: string | undefined;
  reasons?: string | undefined;
}

function HoldCard({
  config,
  ctx,
  lenders,
}: {
  config: ConfigEntry;
  ctx: AccountsContext;
  lenders: readonly LenderChoice[] | null;
}) {
  const rule = config.holdKind === null ? null : releaseRuleWords(config.holdKind);
  return (
    <article className="card">
      <h3>
        {lenderLabel(lenders, config.lenderId)}, provider {config.provider}
      </h3>
      <dl className="facts">
        <div>
          <dt>Mode</dt>
          <dd>{paymentConfigModeWords(config.providerMode)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{paymentConfigStatusWords(config.status, config.providerMode)}</dd>
        </div>
        <div>
          <dt>Hold</dt>
          <dd>
            {holdKindWords(config.holdKind)}
            {config.holdSetAt !== null ? `, since ${formatIst(config.holdSetAt)}` : ''}
          </dd>
        </div>
        <div>
          <dt>Why it is suspended</dt>
          <dd>
            {config.statusReasons.length === 0 ? (
              'No reason code was recorded'
            ) : (
              <ul>
                {config.statusReasons.map((reason) => (
                  <li key={reason}>{paymentConfigReasonWords(reason)}</li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <div>
          <dt>Last check</dt>
          <dd>
            {config.lastValidatedAt === null
              ? 'Not checked yet'
              : `${istOrDash(config.lastValidatedAt)}: ${config.lastValidationOk === true ? 'passed' : config.lastValidationOk === false ? 'did not pass' : 'no result'}`}
          </dd>
        </div>
      </dl>
      {config.holdKind === null ? (
        <p className="muted">
          There is no hold on this configuration, so there is nothing to release. The lender can
          submit it again.
        </p>
      ) : config.status !== 'suspended' ? (
        <p className="muted">Only the hold of a suspended configuration can be released.</p>
      ) : !mayReleaseHold(ctx.caps) ? (
        <SecondPerson>Your role cannot release a hold. That needs the provider right.</SecondPerson>
      ) : (
        <>
          {rule ? <p className="muted">{rule}</p> : null}
          <PlatformForm
            op="hold.release"
            action={ctx.action}
            returnTo={ctx.returnTo}
            hidden={{ id: config.id }}
          >
            <p>
              Releasing the hold does not switch the configuration back on. It stays suspended: the
              lender submits it again, and a different approver at the lender approves it. The
              reason is kept in the history of the configuration.
            </p>
            <TextArea
              name="reason"
              label="Reason for releasing the hold"
              rows={3}
              required
              maxLength={RELEASE_REASON_MAX}
              hint={`${String(RELEASE_REASON_MIN)} to ${String(RELEASE_REASON_MAX)} characters, plain text. Do not type account, phone or identity numbers.`}
            />
            <button type="submit">Release the hold</button>
          </PlatformForm>
        </>
      )}
    </article>
  );
}

/** Suspended payment configurations of every lender, with the hold each carries and the form that releases it. */
export function HoldsPage({
  configs,
  lenders,
  query,
  ctx,
  notice,
}: {
  configs: Loaded<Page<ConfigEntry>>;
  lenders: readonly LenderChoice[] | null;
  query: AccountsQuery;
  ctx: AccountsContext;
  notice: Notice;
}) {
  return (
    <div>
      <h1>Suspended payment configurations</h1>
      <ProvidersNav current="/providers/holds" />
      <p>
        A payment configuration is suspended when the platform uses the kill switch, when the system
        suspends it after a mismatch, or when the nightly check fails. A suspension that carries a
        hold stops the lender from submitting, approving or retiring any payment configuration until
        the hold is released here. Releasing it does not switch anything back on.
      </p>
      <AccountsNotice {...notice} />
      {notice.error === 'self_approval' ? (
        <p className="muted">
          A hold set by a member of staff is released by a different member of staff. If you set
          this hold, ask a colleague.
        </p>
      ) : null}
      <form method="get" action="/providers/holds" className="inline">
        <LenderField
          name="lenderId"
          label="Lender"
          lenders={lenders}
          defaultValue={query.lenderId}
          blank="Any lender"
        />
        <button type="submit" className="secondary">
          Show
        </button>
      </form>
      {!ctx.caps.providersManage ? (
        <p className="muted">Your role cannot release holds. You can read this list.</p>
      ) : null}
      {!configs.ok ? (
        <LoadFailure what="the suspended payment configurations" status={configs.status} />
      ) : configs.data.items.length === 0 ? (
        <EmptyList
          title="No suspended payment configuration"
          detail="Nothing matches this filter, or no payment configuration is suspended."
        />
      ) : (
        <>
          {configs.data.items.map((config) => (
            <HoldCard key={config.id} config={config} ctx={ctx} lenders={lenders} />
          ))}
          <Paging
            nextHref={
              configs.data.nextCursor
                ? accountsHref('/providers/holds', { ...query, cursor: configs.data.nextCursor })
                : null
            }
            firstHref={accountsHref('/providers/holds', withoutCursor(query))}
            hasCursor={query.cursor !== undefined}
            noun="suspended payment configurations"
          />
        </>
      )}
    </div>
  );
}
