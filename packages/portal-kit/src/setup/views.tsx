import {
  PaymentConfigStatus,
  type FeatureSwitchState,
  type MerchantEntry,
  type PaymentConfigEntry,
  type SecretRefPrefix,
} from '@udofin/contracts';
import { OpForm } from '../onboarding/forms.js';
import { CheckInput, SelectInput, TextArea } from '../reminders/fields.js';
import { EmptyList, LoadFailure, Paging, Section } from '../servicing/common.js';
import { dateOrDash, formatIst, istOrDash } from '../servicing/format.js';
import {
  ConfigDraftForm,
  MerchantClaimForm,
  SettlementRequestForm,
  type Choice,
} from './client-forms.js';
import {
  SetupLenderPicker,
  SetupNav,
  SetupNotice,
  type Loaded,
  type SetupContext,
} from './common.js';
import {
  isHeld,
  mayDecide,
  mayIn,
  mayRetire,
  maySubmit,
  maySeeSetup,
  mayWithdraw,
  mayWithdrawMerchant,
  mayWithdrawSettlement,
  setupHref,
  withoutCursor,
  type SetupGrant,
  type SetupQuery,
} from './data.js';
import {
  type FeatureSwitchList,
  type MerchantPage,
  type PaymentConfigHistory,
  type PaymentConfigPage,
  type PaymentProviderChoiceList,
  type SettlementAccountPage,
  type SettlementAccountRegistryStatusList,
} from './types.js';
import {
  actorKindWords,
  configStatusShort,
  configStatusWords,
  eventKindWords,
  featureWords,
  holdKindWords,
  isTestMode,
  merchantStatusWords,
  merchantVerificationWords,
  modeWords,
  railValueWords,
  reasonWords,
  registryStatusWords,
  SECRET_PREFIX,
  setupErrorMessage,
  settlementStatusWords,
} from './wording.js';

// ---------------------------------------------------------------------------------------------------------------
// Names for what a configuration refers to
// ---------------------------------------------------------------------------------------------------------------
type Providers = Loaded<PaymentProviderChoiceList>;
type Merchants = Loaded<MerchantPage>;
type Settlements = Loaded<SettlementAccountPage>;

/** The provider's display name when the register gave one; the provider key (an identifier, not a sentence) otherwise. */
const providerName = (providers: Providers, key: string): string =>
  (providers.ok ? providers.data.items.find((p) => p.provider === key)?.displayName : undefined) ??
  key;

const merchantOf = (merchants: Merchants, id: string): MerchantEntry | undefined =>
  merchants.ok ? merchants.data.items.find((m) => m.id === id) : undefined;

const merchantText = (merchants: Merchants, providers: Providers, id: string): string => {
  const m = merchantOf(merchants, id);
  return m
    ? `${m.merchantRef} at ${providerName(providers, m.provider)}`
    : 'A merchant not in the list';
};

const settlementOf = (settlements: Settlements, id: string) =>
  settlements.ok ? settlements.data.items.find((s) => s.id === id) : undefined;

const settlementText = (settlements: Settlements, id: string): string => {
  const s = settlementOf(settlements, id);
  return s
    ? `${s.label}, ${s.bankName ?? 'bank not given'}, ${s.maskedRef}`
    : 'A settlement account not in the list';
};

const NoLender = ({ what }: { what: string }) => <LoadFailure what={what} status={403} />;

/** A configuration in a test mode says so wherever it appears. */
function TestOnly({ mode }: { mode: string }) {
  return isTestMode(mode) ? (
    <p role="status">
      <strong>Test only.</strong> This configuration uses a test provider. It is never a live
      payment setup.
    </p>
  ) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// The list of configurations
// ---------------------------------------------------------------------------------------------------------------
export function SetupConfigsPage({
  lender,
  configs,
  providers,
  merchants,
  settlements,
  query,
  ctx,
  done,
  error,
}: {
  lender: SetupGrant | null;
  configs: Loaded<PaymentConfigPage>;
  providers: Providers;
  merchants: Merchants;
  settlements: Settlements;
  query: SetupQuery;
  ctx: SetupContext;
  done?: boolean;
  error?: string | undefined;
}) {
  const lenders = ctx.grants.filter(maySeeSetup);
  return (
    <div>
      <h1>Payment setup</h1>
      <SetupNav current="/payment-setup" />
      <p>
        A payment configuration names the provider, the merchant and the settlement account that
        belong to your organisation. It can be used only after another person in your organisation
        has approved it and the platform team has verified the merchant and the settlement account.
        “Approved” does not by itself mean that payments are switched on for your organisation: see
        Features.
      </p>
      <SetupNotice done={done} error={error} />
      {lender === null ? (
        <NoLender what="the payment setup" />
      ) : (
        <>
          <SetupLenderPicker lenders={lenders} selected={lender.lenderId} path="/payment-setup" />
          <form method="get" action="/payment-setup" className="inline">
            <input type="hidden" name="lenderId" value={lender.lenderId} />
            <SelectInput
              name="status"
              label="Status"
              blank="All statuses"
              options={PaymentConfigStatus.options.map((s) => ({
                value: s,
                label: configStatusShort(s),
              }))}
              defaultValue={query.status}
            />
            <button type="submit" className="secondary">
              Show
            </button>
          </form>
          {!configs.ok ? (
            <LoadFailure what="the configurations" status={configs.status} />
          ) : configs.data.items.length === 0 ? (
            <EmptyList
              title="No payment configuration"
              detail="Nothing has been drafted for this lender. Start with a merchant and a settlement account, then draft a configuration."
            />
          ) : (
            <>
              <table>
                <caption>Payment configurations, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Provider</th>
                    <th scope="col">Mode</th>
                    <th scope="col">Status</th>
                    <th scope="col">Merchant</th>
                    <th scope="col">Settlement account</th>
                    <th scope="col">Last check</th>
                    <th scope="col">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {configs.data.items.map((c) => (
                    <tr key={c.id}>
                      <th scope="row">{providerName(providers, c.provider)}</th>
                      <td>{modeWords(c.providerMode)}</td>
                      <td>{configStatusWords(c.status, c.providerMode)}</td>
                      <td>{merchantText(merchants, providers, c.merchantRegistryId)}</td>
                      <td>{settlementText(settlements, c.settlementAccountId)}</td>
                      <td>
                        {c.lastValidatedAt === null
                          ? 'Not checked yet'
                          : `${formatIst(c.lastValidatedAt)}: ${c.lastValidationOk === true ? 'passed' : c.lastValidationOk === false ? 'did not pass' : 'no result'}`}
                      </td>
                      <td>
                        <a href={`/payment-setup/${c.id}`}>
                          Open{' '}
                          <span className="sr-only">
                            the configuration drafted {formatIst(c.draftedAt)}
                          </span>
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Paging
                nextHref={
                  configs.data.nextCursor
                    ? setupHref('/payment-setup', {
                        ...query,
                        lenderId: lender.lenderId,
                        cursor: configs.data.nextCursor,
                      })
                    : null
                }
                firstHref={setupHref('/payment-setup', {
                  ...withoutCursor(query),
                  lenderId: lender.lenderId,
                })}
                hasCursor={query.cursor !== undefined}
                noun="configurations"
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// A new configuration
// ---------------------------------------------------------------------------------------------------------------
export function SetupNewConfigPage({
  lender,
  providers,
  merchants,
  settlements,
  prefix,
  ctx,
  done,
  error,
}: {
  lender: SetupGrant | null;
  providers: Providers;
  merchants: Merchants;
  settlements: Settlements;
  /** The prefix the lender's secret names must start with. Without it the form is not drawn: nobody could name a secret. */
  prefix: Loaded<SecretRefPrefix>;
  ctx: SetupContext;
  done?: boolean;
  error?: string | undefined;
}) {
  const lenders = ctx.grants.filter((g) => g.configure);
  const providerChoices: Choice[] = providers.ok
    ? providers.data.items.map((p) => ({ value: p.provider, label: p.displayName }))
    : [];
  const merchantChoices: Choice[] = merchants.ok
    ? merchants.data.items
        .filter((m) => m.status === 'active')
        .map((m) => ({
          value: m.id,
          label: `${merchantText(merchants, providers, m.id)} (${m.verificationStatus === 'verified' ? 'verified' : 'not verified yet'})`,
        }))
    : [];
  const settlementChoices: Choice[] = settlements.ok
    ? settlements.data.items
        .filter((s) => s.status !== 'revoked')
        .map((s) => ({
          value: s.id,
          label: `${s.label}, ${s.bankName ?? 'bank not given'}, ${s.maskedRef} (${s.status === 'verified' ? 'verified' : 'not verified yet'})`,
        }))
    : [];
  const ready =
    providerChoices.length > 0 && merchantChoices.length > 0 && settlementChoices.length > 0;
  /** The first list that could not be loaded, whose status says whether it was a refusal or a failure. */
  const failedLoad = [providers, merchants, settlements].find((loaded) => !loaded.ok);
  // The prefix is used only when it is the one asked for this lender and has the shape of a prefix.
  const secretPrefix =
    lender !== null &&
    prefix.ok &&
    prefix.data.lenderId === lender.lenderId &&
    SECRET_PREFIX.test(prefix.data.prefix)
      ? prefix.data.prefix
      : null;
  return (
    <div>
      <h1>New payment configuration</h1>
      <SetupNav current="/payment-setup/new" />
      <SetupNotice done={done} error={error} />
      {lender === null || !mayIn(ctx.grants, lender.lenderId, 'configure') ? (
        <EmptyList
          title="You cannot draft a configuration"
          detail="Drafting needs the right to configure payments for this lender."
        />
      ) : (
        <>
          <SetupLenderPicker
            lenders={lenders}
            selected={lender.lenderId}
            path="/payment-setup/new"
          />
          <p>
            Choose the provider, the merchant and the settlement account of your organisation. A
            secret is named, never typed: you give the NAME of the secret in your secrets manager,
            and every name starts with the prefix of your organisation, which is shown on the form.
            Saving a draft creates a callback path that is shown to you once. Another person must
            approve the configuration before it is used.
          </p>
          {failedLoad === undefined ? null : (
            <LoadFailure what="the choices for a configuration" status={failedLoad.status} />
          )}
          {secretPrefix === null ? (
            <p role="alert" className="form-error">
              {setupErrorMessage('secret_prefix_unknown')}
            </p>
          ) : !ready ? (
            <EmptyList
              title="Not ready to draft yet"
              detail="You need an approved provider to choose, a claimed merchant and a requested settlement account. Merchants and settlement accounts are set up under “Merchants and settlement accounts”."
            />
          ) : (
            <Section title="Draft a configuration">
              <ConfigDraftForm
                lenderId={lender.lenderId}
                secretPrefix={secretPrefix}
                action={ctx.draftConfig}
                returnTo={ctx.returnTo}
                providers={providerChoices}
                merchants={merchantChoices}
                settlementAccounts={settlementChoices}
              />
            </Section>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// One configuration
// ---------------------------------------------------------------------------------------------------------------
function RailLimits({ config }: { config: PaymentConfigEntry }) {
  const rails = Object.entries(config.railLimits);
  if (rails.length === 0) return <p>No rail limit was recorded.</p>;
  return (
    <>
      <p className="muted">
        Numbers are shown as stored. An amount is stored in paise (100 paise is 1 rupee). Source:{' '}
        {config.railLimitsSource ?? 'no source was recorded'}
      </p>
      <table>
        <caption>Rail limits as recorded</caption>
        <thead>
          <tr>
            <th scope="col">Rail</th>
            <th scope="col">Limit</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {rails.flatMap(([rail, limits]) =>
            Object.entries(limits).map(([limit, value]) => (
              <tr key={`${rail}/${limit}`}>
                <th scope="row">{rail}</th>
                <td>{limit}</td>
                <td>{railValueWords(value)}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </>
  );
}

function History({ history }: { history: Loaded<PaymentConfigHistory> }) {
  if (!history.ok) return <LoadFailure what="the history" status={history.status} />;
  if (history.data.items.length === 0) return <p>No change has been recorded.</p>;
  return (
    <table>
      <caption>Changes, oldest first</caption>
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">Change</th>
          <th scope="col">By</th>
          <th scope="col">Reasons</th>
        </tr>
      </thead>
      <tbody>
        {history.data.items.map((e) => (
          <tr key={e.id}>
            <th scope="row">{formatIst(e.occurredAt)}</th>
            <td>
              {eventKindWords(e.eventKind)}
              {e.fromStatus !== null && e.fromStatus !== e.toStatus
                ? ` (from ${configStatusShort(e.fromStatus).toLowerCase()} to ${configStatusShort(e.toStatus ?? '').toLowerCase()})`
                : ''}
            </td>
            <td>{actorKindWords(e.actorKind)}</td>
            <td>
              {e.reasons.length === 0 ? (
                '—'
              ) : (
                <ul>
                  {e.reasons.map((r) => (
                    <li key={r}>{reasonWords(r)}</li>
                  ))}
                </ul>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DecideForm({ id, ctx }: { id: string; ctx: SetupContext }) {
  return (
    <form action={ctx.action} className="form">
      <input type="hidden" name="op" value="setup.config.decide" />
      <input type="hidden" name="key" value={`ui-${crypto.randomUUID()}`} />
      <input type="hidden" name="returnTo" value={ctx.returnTo} />
      <input type="hidden" name="id" value={id} />
      <TextArea
        name="note"
        label="Note"
        rows={3}
        maxLength={1000}
        hint="Optional when you approve. Rejecting retires this configuration and needs a note of at least 10 characters. No personal details."
      />
      <p>
        <button type="submit" name="decision" value="approve">
          Approve this configuration
        </button>{' '}
        <button type="submit" name="decision" value="reject" className="secondary">
          Reject this configuration
        </button>
      </p>
    </form>
  );
}

export function SetupConfigDetailPage({
  config,
  history,
  providers,
  merchants,
  settlements,
  ctx,
  done,
  error,
}: {
  config: Loaded<PaymentConfigEntry>;
  history: Loaded<PaymentConfigHistory>;
  providers: Providers;
  merchants: Merchants;
  settlements: Settlements;
  ctx: SetupContext;
  done?: boolean;
  error?: string | undefined;
}) {
  return (
    <div>
      <h1>Payment configuration</h1>
      <SetupNav current={null} />
      <p>
        <a href="/payment-setup">Back to the configurations</a>
      </p>
      <SetupNotice done={done} error={error} />
      {!config.ok ? (
        config.status === 404 ? (
          <EmptyList
            title="Configuration not found"
            detail="That configuration is not one of your organisation’s, or it does not exist."
          />
        ) : (
          <LoadFailure what="the configuration" status={config.status} />
        )
      ) : (
        <ConfigBody
          c={config.data}
          history={history}
          providers={providers}
          merchants={merchants}
          settlements={settlements}
          ctx={ctx}
        />
      )}
    </div>
  );
}

function ConfigBody({
  c,
  history,
  providers,
  merchants,
  settlements,
  ctx,
}: {
  c: PaymentConfigEntry;
  history: Loaded<PaymentConfigHistory>;
  providers: Providers;
  merchants: Merchants;
  settlements: Settlements;
  ctx: SetupContext;
}) {
  const own =
    c.status === 'pending_approval' && (c.draftedBy === ctx.userId || c.submittedBy === ctx.userId);
  const who = (id: string | null) =>
    id === null ? '—' : id === ctx.userId ? 'you' : `another person (ID ${id})`;
  return (
    <>
      <TestOnly mode={c.providerMode} />
      <Section title="This configuration">
        <dl className="facts">
          <div>
            <dt>Provider</dt>
            <dd>{providerName(providers, c.provider)}</dd>
          </div>
          <div>
            <dt>Mode</dt>
            <dd>{modeWords(c.providerMode)}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{configStatusWords(c.status, c.providerMode)}</dd>
          </div>
          <div>
            <dt>Merchant</dt>
            <dd>{merchantText(merchants, providers, c.merchantRegistryId)}</dd>
          </div>
          <div>
            <dt>Settlement account</dt>
            <dd>{settlementText(settlements, c.settlementAccountId)}</dd>
          </div>
          <div>
            <dt>Name of the provider secret</dt>
            <dd>{c.secretRef}</dd>
          </div>
          <div>
            <dt>Name of the callback signing secret</dt>
            <dd>{c.webhookSecretRef}</dd>
          </div>
          <div>
            <dt>Provider onboarding confirmation reference</dt>
            <dd>{c.evidenceRef ?? 'Not given yet'}</dd>
          </div>
          <div>
            <dt>Contract section reference</dt>
            <dd>{c.contractSectionRef ?? 'Not given yet'}</dd>
          </div>
          <div>
            <dt>Drafted</dt>
            <dd>
              By {who(c.draftedBy)} on {formatIst(c.draftedAt)}
            </dd>
          </div>
          <div>
            <dt>Submitted</dt>
            <dd>
              {c.submittedBy !== null && c.submittedAt !== null
                ? `By ${who(c.submittedBy)} on ${formatIst(c.submittedAt)}`
                : 'Not submitted'}
            </dd>
          </div>
          <div>
            <dt>Approved</dt>
            <dd>
              {c.approvedBy !== null && c.approvedAt !== null
                ? `By ${who(c.approvedBy)} on ${formatIst(c.approvedAt)}`
                : 'Not approved'}
            </dd>
          </div>
          {isHeld(c) ? (
            <div>
              <dt>Hold</dt>
              <dd>
                {holdKindWords(c.holdKind ?? '')}
                {c.holdSetAt !== null ? ` since ${formatIst(c.holdSetAt)}` : ''}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Last check of the settlement account and merchant</dt>
            <dd>
              {c.lastValidatedAt === null
                ? 'Not checked yet'
                : `${formatIst(c.lastValidatedAt)}: ${c.lastValidationOk === true ? 'passed' : c.lastValidationOk === false ? 'did not pass' : 'no result'}`}
            </dd>
          </div>
        </dl>
        <p className="muted">
          The two secret names are names only. Udofin never shows or stores the secrets they name.
        </p>
        {c.statusReasons.length > 0 ? (
          <>
            <h3>Why it is not in use</h3>
            <ul>
              {c.statusReasons.map((r) => (
                <li key={r}>{reasonWords(r)}</li>
              ))}
            </ul>
          </>
        ) : null}
      </Section>
      <Section title="Rail limits">
        <RailLimits config={c} />
      </Section>
      <Section title="What you can do">
        {isHeld(c) ? (
          <p role="status">
            <strong>This configuration is on hold.</strong> While a hold stands you cannot submit or
            retire it, and you cannot submit or approve any other payment configuration of your
            organisation. Only the platform team can release the hold. After it is released, you
            submit this configuration again and a different person approves it.
          </p>
        ) : null}
        {own ? (
          <p className="muted">
            You drafted or submitted this configuration, so another person must decide it.
          </p>
        ) : null}
        {maySubmit(ctx.grants, c) ? (
          <OpForm
            op="setup.config.submit"
            action={ctx.action}
            returnTo={ctx.returnTo}
            hidden={{ id: c.id }}
            submit="Submit for approval"
          >
            <p className="muted">
              Submitting checks the settlement account, the merchant, the provider and the
              references now. If a check does not pass, the reasons are shown above.
            </p>
          </OpForm>
        ) : null}
        {mayDecide(ctx.grants, c, ctx.userId) ? <DecideForm id={c.id} ctx={ctx} /> : null}
        {mayWithdraw(ctx.grants, c) ? (
          <OpForm
            op="setup.config.withdraw"
            action={ctx.action}
            returnTo={ctx.returnTo}
            hidden={{ id: c.id }}
            submit="Withdraw this configuration"
            secondary
          >
            <TextArea
              name="reason"
              label="Reason for withdrawing"
              rows={2}
              maxLength={1000}
              required
              hint="10 to 1,000 characters, no personal details."
            />
          </OpForm>
        ) : null}
        {mayRetire(ctx.grants, c) ? (
          <OpForm
            op="setup.config.retire"
            action={ctx.action}
            returnTo={ctx.returnTo}
            hidden={{ id: c.id }}
            submit="Retire this configuration"
            secondary
          >
            <TextArea
              name="reason"
              label="Reason for retiring"
              rows={2}
              maxLength={1000}
              required
              hint="10 to 1,000 characters, no personal details."
            />
          </OpForm>
        ) : null}
        <p className="muted">
          Only the platform team can suspend a configuration. A suspended configuration can be
          submitted again, unless a hold stands on it: only the platform team can release a hold.
        </p>
      </Section>
      <Section title="History">
        <History history={history} />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Merchants, settlement accounts and their registry status
// ---------------------------------------------------------------------------------------------------------------
const WITHDRAW_WORDS = {
  claim: {
    summary: 'Withdraw this claim',
    explain:
      'Withdrawing ends this claim. It stays in the list as history and is not used again. The same identifier can be claimed again later: that is a new claim, and it starts unverified. A verified merchant cannot be withdrawn here: the platform team revokes it.',
    confirm: 'I want to withdraw this claim.',
  },
  'settlement account request': {
    summary: 'Withdraw this request',
    explain:
      'Withdrawing ends this request. It stays in the list as history and is not used again. The same bank and masked reference can be asked for again later: that is a new request, and it starts unverified. An account that is linked to the account registry cannot be withdrawn here: the platform team revokes it.',
    confirm: 'I want to withdraw this request.',
  },
} as const;

/** One withdrawal with its explanation and a confirm step. It names the record for screen readers. The API decides again. */
function WithdrawForm({
  what,
  op,
  id,
  lenderId,
  named,
  ctx,
}: {
  what: keyof typeof WITHDRAW_WORDS;
  op: 'setup.merchant.withdraw' | 'setup.settlement.withdraw';
  id: string;
  lenderId: string;
  named: string;
  ctx: SetupContext;
}) {
  const words = WITHDRAW_WORDS[what];
  return (
    <details>
      <summary>
        {words.summary} <span className="sr-only">({named})</span>
      </summary>
      <OpForm
        op={op}
        action={ctx.action}
        returnTo={ctx.returnTo}
        hidden={{ id, lenderId }}
        submit={words.summary}
        secondary
      >
        <p>{words.explain}</p>
        <CheckInput name="confirm" required label={words.confirm} />
      </OpForm>
    </details>
  );
}

export function SetupAccountsPage({
  lender,
  providers,
  merchants,
  settlements,
  registry,
  ctx,
  done,
  error,
}: {
  lender: SetupGrant | null;
  providers: Providers;
  merchants: Merchants;
  settlements: Settlements;
  registry: Loaded<SettlementAccountRegistryStatusList>;
  ctx: SetupContext;
  done?: boolean;
  error?: string | undefined;
}) {
  const lenders = ctx.grants.filter(maySeeSetup);
  const mayConfigure = lender !== null && mayIn(ctx.grants, lender.lenderId, 'configure');
  const providerChoices: Choice[] = providers.ok
    ? providers.data.items.map((p) => ({ value: p.provider, label: p.displayName }))
    : [];
  return (
    <div>
      <h1>Merchants and settlement accounts</h1>
      <SetupNav current="/payment-setup/accounts" />
      <SetupNotice done={done} error={error} />
      {lender === null ? (
        <NoLender what="the merchants and settlement accounts" />
      ) : (
        <>
          <SetupLenderPicker
            lenders={lenders}
            selected={lender.lenderId}
            path="/payment-setup/accounts"
          />
          <Section title="Merchants">
            <p>
              A merchant identifier is the one your provider gave your organisation. A claim starts
              unverified: the platform team confirms, against evidence, that it belongs to your
              organisation. Only a limited number of claims can wait for verification at the same
              time: withdraw the ones you do not need.
            </p>
            {mayConfigure ? (
              providerChoices.length === 0 ? (
                <p className="muted">No provider is available to claim a merchant at yet.</p>
              ) : (
                <MerchantClaimForm
                  lenderId={lender.lenderId}
                  action={ctx.draft}
                  returnTo={ctx.returnTo}
                  providers={providerChoices}
                />
              )
            ) : null}
            {!merchants.ok ? (
              <LoadFailure what="the merchants" status={merchants.status} />
            ) : merchants.data.items.length === 0 ? (
              <EmptyList
                title="No merchant"
                detail="No merchant identifier has been claimed yet."
              />
            ) : (
              <table>
                <caption>Merchants</caption>
                <thead>
                  <tr>
                    <th scope="col">Provider</th>
                    <th scope="col">Identifier</th>
                    <th scope="col">Claim</th>
                    <th scope="col">Verification</th>
                    <th scope="col">Claimed</th>
                    <th scope="col">Verified</th>
                    {mayConfigure ? <th scope="col">What you can do</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {merchants.data.items.map((m) => (
                    <tr key={m.id}>
                      <th scope="row">{providerName(providers, m.provider)}</th>
                      <td>{m.merchantRef}</td>
                      <td>{merchantStatusWords(m.status)}</td>
                      <td>{merchantVerificationWords(m.verificationStatus)}</td>
                      <td>{formatIst(m.claimedAt)}</td>
                      <td>{istOrDash(m.verifiedAt)}</td>
                      {mayConfigure ? (
                        <td>
                          {mayWithdrawMerchant(ctx.grants, m) ? (
                            <WithdrawForm
                              what="claim"
                              op="setup.merchant.withdraw"
                              id={m.id}
                              lenderId={lender.lenderId}
                              named={m.merchantRef}
                              ctx={ctx}
                            />
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
          <Section title="Settlement accounts">
            <p>
              Name an account of your organisation by a label, the bank and its masked reference
              only. Never type the full account number: this form does not accept it. The platform
              team verifies the account against its own register and links it to your request.
            </p>
            {mayConfigure ? (
              <SettlementRequestForm
                lenderId={lender.lenderId}
                action={ctx.draft}
                returnTo={ctx.returnTo}
              />
            ) : null}
            {!settlements.ok ? (
              <LoadFailure what="the settlement accounts" status={settlements.status} />
            ) : settlements.data.items.length === 0 ? (
              <EmptyList
                title="No settlement account"
                detail="No settlement account has been requested yet."
              />
            ) : (
              <table>
                <caption>Settlement accounts</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Bank</th>
                    <th scope="col">Masked reference</th>
                    <th scope="col">Status</th>
                    <th scope="col">Account registry</th>
                    <th scope="col">Requested</th>
                    {mayConfigure ? <th scope="col">What you can do</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {settlements.data.items.map((s) => (
                    <tr key={s.id}>
                      <th scope="row">{s.label}</th>
                      <td>{s.bankName ?? '—'}</td>
                      <td>{s.maskedRef}</td>
                      <td>{settlementStatusWords(s.status)}</td>
                      <td>
                        {s.registryId === null
                          ? 'Not linked to the account registry yet'
                          : 'Linked to the account registry'}
                      </td>
                      <td>{formatIst(s.createdAt)}</td>
                      {mayConfigure ? (
                        <td>
                          {mayWithdrawSettlement(ctx.grants, s) ? (
                            <WithdrawForm
                              what="settlement account request"
                              op="setup.settlement.withdraw"
                              id={s.id}
                              lenderId={lender.lenderId}
                              named={`${s.label}, ${s.maskedRef}`}
                              ctx={ctx}
                            />
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
          <Section title="Account registry status">
            <p className="muted">
              What the platform’s account registry reports for your linked settlement accounts: the
              masked reference and the verification status only.
            </p>
            {!registry.ok ? (
              <LoadFailure what="the registry status" status={registry.status} />
            ) : registry.data.items.length === 0 ? (
              <EmptyList
                title="Nothing linked yet"
                detail="None of your settlement accounts is linked to the account registry yet."
              />
            ) : (
              <table>
                <caption>Registry status of your settlement accounts</caption>
                <thead>
                  <tr>
                    <th scope="col">Settlement account</th>
                    <th scope="col">Masked reference</th>
                    <th scope="col">Registry status</th>
                    <th scope="col">In effect from</th>
                    <th scope="col">In effect until</th>
                    <th scope="col">Can be used for payments now</th>
                  </tr>
                </thead>
                <tbody>
                  {registry.data.items.map((r) => (
                    <tr key={r.settlementAccountId}>
                      <th scope="row">
                        {settlementOf(settlements, r.settlementAccountId)?.label ??
                          'A settlement account'}
                      </th>
                      <td>{r.maskedRef}</td>
                      <td>{registryStatusWords(r.verificationStatus)}</td>
                      <td>{dateOrDash(r.effectiveFrom)}</td>
                      <td>{dateOrDash(r.effectiveTo)}</td>
                      <td>{r.usable ? 'Yes, as the registry reports' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Feature switches: read only
// ---------------------------------------------------------------------------------------------------------------
function SwitchState({ f }: { f: FeatureSwitchState }) {
  if (f.enabled)
    return (
      <>
        On{f.enabledAt !== null ? ` since ${formatIst(f.enabledAt)}` : ''}. This is the stored
        switch. It does not by itself show that the feature is working for your borrowers.
      </>
    );
  if (!f.enableable) return <>Off. This feature cannot be switched on at present.</>;
  if (f.disabledAt !== null) return <>Off. It was switched off on {formatIst(f.disabledAt)}.</>;
  return <>Off. It has not been switched on for your organisation.</>;
}

export function SetupFeaturesPage({
  lender,
  features,
  ctx,
}: {
  lender: SetupGrant | null;
  features: Loaded<FeatureSwitchList>;
  ctx: SetupContext;
}) {
  const lenders = ctx.grants.filter(maySeeSetup);
  return (
    <div>
      <h1>Features</h1>
      <SetupNav current="/payment-setup/features" />
      <p>
        These switches are read-only. Only the platform team can change them; your organisation
        cannot switch a feature on or off from here. Switching a feature on takes two platform
        people: one asks and a different person decides. The platform team can switch a feature off
        with one person, at once, in an emergency; switching it on again then needs a new two-person
        request. Every change is kept in the platform’s history.
      </p>
      {lender === null ? (
        <NoLender what="the features" />
      ) : (
        <>
          <SetupLenderPicker
            lenders={lenders}
            selected={lender.lenderId}
            path="/payment-setup/features"
          />
          {!features.ok ? (
            <LoadFailure what="the features" status={features.status} />
          ) : features.data.items.length === 0 ? (
            <EmptyList title="No feature" detail="No feature switch was reported." />
          ) : (
            <table>
              <caption>Feature switches for this lender</caption>
              <thead>
                <tr>
                  <th scope="col">Feature</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {features.data.items.map((f) => (
                  <tr key={`${f.lenderId}/${f.feature}`}>
                    <th scope="row">{featureWords(f.feature)}</th>
                    <td>
                      <SwitchState f={f} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
