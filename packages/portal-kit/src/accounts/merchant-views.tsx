import { AreaField, SelectField, TextField } from '../onboarding/forms.js';
import { EmptyList, LoadFailure, Paging } from '../servicing/common.js';
import { istOrDash } from '../servicing/format.js';
import {
  AccountsNav,
  AccountsNotice,
  LenderField,
  PlatformForm,
  ProviderField,
  SecondPerson,
  Section,
  type AccountsContext,
} from './common.js';
import { accountsHref, lenderLabel, withoutCursor, type AccountsQuery } from './data.js';
import {
  type LenderChoice,
  type Loaded,
  type MerchantRow,
  type Page,
  type ProviderEntry,
  type RegistryEntry,
  type SettlementEntry,
} from './types.js';
import {
  MERCHANT_STATUSES,
  MERCHANT_VERIFICATIONS,
  merchantOwnerWords,
  merchantStatusWords,
  merchantVerificationWords,
  ownerKindWords,
  settlementStatusWords,
} from './wording.js';

const words = (list: readonly string[], f: (v: string) => string) =>
  list.map((value) => ({ value, label: f(value) }));

interface Notice {
  done?: boolean | undefined;
  error?: string | undefined;
  result?: string | undefined;
  reasons?: string | undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Settlement accounts waiting to be linked to a registry entry
// ---------------------------------------------------------------------------------------------------------------
function SettlementCard({
  account,
  candidates,
  ctx,
  lenders,
}: {
  account: SettlementEntry;
  candidates: readonly RegistryEntry[];
  ctx: AccountsContext;
  lenders: readonly LenderChoice[] | null;
}) {
  const mine = candidates.filter((c) => c.ownerOrgId === account.lenderId);
  const linkable = account.registryId === null && account.status !== 'revoked';
  return (
    <article className="card">
      <h3>
        {account.label}, {account.maskedRef}
      </h3>
      <dl className="facts">
        <div>
          <dt>Lender</dt>
          <dd>{lenderLabel(lenders, account.lenderId)}</dd>
        </div>
        <div>
          <dt>Bank</dt>
          <dd>{account.bankName ?? 'Not given'}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{settlementStatusWords(account.status)}</dd>
        </div>
        <div>
          <dt>Requested</dt>
          <dd>{istOrDash(account.createdAt)}</dd>
        </div>
      </dl>
      {linkable && ctx.caps.registryManage ? (
        mine.length === 0 ? (
          <p className="muted">
            No verified registry entry owned by this lender is available to link. Register the
            account and have a different person verify it first.
          </p>
        ) : (
          <PlatformForm
            op="settlement.link"
            action={ctx.action}
            returnTo={ctx.returnTo}
            hidden={{ id: account.id }}
          >
            <SelectField
              name="registryId"
              label="Verified registry entry to link"
              blank="Choose an entry"
              required
              options={mine.map((c) => ({
                value: c.id,
                label: `${c.maskedRef}, ${ownerKindWords(c.ownerKind)}`,
              }))}
            />
            <button type="submit">Link the account</button>
            <p className="muted">
              The masked references must be the same. The database checks this and the rest.
            </p>
          </PlatformForm>
        )
      ) : null}
      {linkable && !ctx.caps.registryManage ? (
        <SecondPerson>Your role cannot link settlement accounts.</SecondPerson>
      ) : null}
    </article>
  );
}

export function SettlementPage({
  accounts,
  verified,
  lenders,
  query,
  ctx,
  notice,
}: {
  accounts: Loaded<Page<SettlementEntry>>;
  /** The verified registry entries a link may point at (the first hundred). Null when they could not be read. */
  verified: Loaded<Page<RegistryEntry>> | null;
  lenders: readonly LenderChoice[] | null;
  query: AccountsQuery;
  ctx: AccountsContext;
  notice: Notice;
}) {
  const candidates = verified?.ok ? verified.data.items : [];
  return (
    <div>
      <h1>Settlement accounts</h1>
      <AccountsNav current="/accounts/settlement" />
      <p>
        A lender asks for a settlement account by giving a label, a bank and a masked reference. It
        is usable only after it is linked to a verified registry entry that the same lender owns.
      </p>
      <AccountsNotice {...notice} />
      <form method="get" action="/accounts/settlement" className="inline">
        <SelectField
          name="linked"
          label="Link"
          blank="All"
          options={[
            { value: 'false', label: 'Not linked yet' },
            { value: 'true', label: 'Linked' },
          ]}
          defaultValue={query.linked ?? ''}
        />
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
      {verified && !verified.ok ? (
        <p role="status">
          The verified registry entries could not be read, so no link can be made from this page
          right now.
        </p>
      ) : null}
      {verified?.ok && verified.data.nextCursor ? (
        <p role="status" className="muted">
          More verified entries exist than are listed here. Choose a lender above to list the
          entries that lender owns.
        </p>
      ) : null}
      {!accounts.ok ? (
        <LoadFailure what="the settlement accounts" status={accounts.status} />
      ) : accounts.data.items.length === 0 ? (
        <EmptyList
          title="No settlement accounts"
          detail="Nothing matches this filter, or no lender has asked for one yet."
        />
      ) : (
        <>
          {accounts.data.items.map((account) => (
            <SettlementCard
              key={account.id}
              account={account}
              candidates={verified?.ok ? candidates : []}
              ctx={ctx}
              lenders={lenders}
            />
          ))}
          <Paging
            nextHref={
              accounts.data.nextCursor
                ? accountsHref('/accounts/settlement', {
                    ...query,
                    cursor: accounts.data.nextCursor,
                  })
                : null
            }
            firstHref={accountsHref('/accounts/settlement', withoutCursor(query))}
            hasCursor={query.cursor !== undefined}
            noun="settlement accounts"
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Merchants
// ---------------------------------------------------------------------------------------------------------------
function MerchantCard({
  merchant,
  ctx,
  lenders,
}: {
  merchant: MerchantRow;
  ctx: AccountsContext;
  lenders: readonly LenderChoice[] | null;
}) {
  const fees = merchant.ownerKind === 'udofin_fees';
  return (
    <article className="card">
      <h3>
        {merchant.provider}, {merchant.merchantRef}
      </h3>
      <dl className="facts">
        <div>
          <dt>Belongs to</dt>
          <dd>
            {merchantOwnerWords(merchant.ownerKind)}
            {merchant.ownerOrgId ? `: ${lenderLabel(lenders, merchant.ownerOrgId)}` : ''}
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{merchantStatusWords(merchant.status)}</dd>
        </div>
        <div>
          <dt>Verification</dt>
          <dd>
            {merchantVerificationWords(merchant.verificationStatus)}
            {merchant.verificationEvidenceRef
              ? `; evidence: ${merchant.verificationEvidenceRef}`
              : ''}
          </dd>
        </div>
        <div>
          <dt>Claimed</dt>
          <dd>{istOrDash(merchant.claimedAt)}</dd>
        </div>
        {merchant.verifiedAt ? (
          <div>
            <dt>Verified</dt>
            <dd>{istOrDash(merchant.verifiedAt)}</dd>
          </div>
        ) : null}
        {merchant.revokedAt ? (
          <div>
            <dt>Revoked</dt>
            <dd>
              {istOrDash(merchant.revokedAt)}
              {merchant.revokedReason ? `: ${merchant.revokedReason}` : ''}
            </dd>
          </div>
        ) : null}
      </dl>
      {fees ? (
        <p className="muted">
          Udofin’s own fee merchant. A lender’s payment configuration can never use it.
        </p>
      ) : null}
      {ctx.caps.providersManage && merchant.status === 'active' ? (
        <>
          {merchant.verificationStatus === 'unverified' ? (
            <details>
              <summary>Verify this merchant</summary>
              <PlatformForm
                op="merchant.verify"
                action={ctx.action}
                returnTo={ctx.returnTo}
                hidden={{ id: merchant.id }}
              >
                <TextField
                  name="evidenceRef"
                  label="Reference to the provider’s confirmation"
                  required
                  hint="A short title or reference of the document, not its contents."
                />
                <button type="submit">Verify the merchant</button>
              </PlatformForm>
            </details>
          ) : null}
          <details>
            <summary>Revoke this merchant</summary>
            <PlatformForm
              op="merchant.revoke"
              action={ctx.action}
              returnTo={ctx.returnTo}
              hidden={{ id: merchant.id }}
            >
              <p>
                Revoking suspends the active payment configurations that use this merchant. The
                reference stays taken.
              </p>
              <AreaField
                name="reason"
                label="Reason"
                required
                hint="At least 10 characters. Do not type account, phone or identity numbers."
              />
              <button type="submit">Revoke the merchant</button>
            </PlatformForm>
          </details>
        </>
      ) : null}
    </article>
  );
}

export function MerchantsPage({
  merchants,
  providers,
  lenders,
  query,
  ctx,
  notice,
}: {
  merchants: Loaded<Page<MerchantRow>>;
  providers: readonly ProviderEntry[] | null;
  lenders: readonly LenderChoice[] | null;
  query: AccountsQuery;
  ctx: AccountsContext;
  notice: Notice;
}) {
  const items = merchants.ok ? merchants.data.items : [];
  const feeMerchants = items.filter((m) => m.ownerKind === 'udofin_fees');
  const lenderMerchants = items.filter((m) => m.ownerKind !== 'udofin_fees');
  return (
    <div>
      <h1>Merchants</h1>
      <AccountsNav current="/accounts/merchants" />
      <p>
        A merchant reference is the provider’s identifier for the account that receives money. A
        lender claims its own; staff verify it against the provider’s confirmation. Udofin’s fee
        merchant is separate and can never receive a borrower’s repayment.
      </p>
      <AccountsNotice {...notice} />
      <form method="get" action="/accounts/merchants" className="inline">
        <SelectField
          name="verification"
          label="Verification"
          blank="All"
          options={words(MERCHANT_VERIFICATIONS, merchantVerificationWords)}
          defaultValue={query.verification ?? ''}
        />
        <SelectField
          name="status"
          label="Status"
          blank="All"
          options={words(MERCHANT_STATUSES, merchantStatusWords)}
          defaultValue={query.status ?? ''}
        />
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
        <p className="muted">Your role cannot verify or revoke merchants.</p>
      ) : null}
      {!merchants.ok ? (
        <LoadFailure what="the merchants" status={merchants.status} />
      ) : (
        <>
          <Section title="Lenders’ repayment merchants">
            {lenderMerchants.length === 0 ? (
              <EmptyList
                title="No merchants"
                detail="Nothing matches this filter, or no lender has claimed one yet."
              />
            ) : (
              lenderMerchants.map((merchant) => (
                <MerchantCard key={merchant.id} merchant={merchant} ctx={ctx} lenders={lenders} />
              ))
            )}
          </Section>
          <Section title="Udofin’s fee merchants">
            {feeMerchants.length === 0 ? (
              <EmptyList
                title="No fee merchant"
                detail="No fee merchant is listed on this page of results."
              />
            ) : (
              feeMerchants.map((merchant) => (
                <MerchantCard key={merchant.id} merchant={merchant} ctx={ctx} lenders={lenders} />
              ))
            )}
            {ctx.caps.providersManage ? (
              <details>
                <summary>Register Udofin’s fee merchant</summary>
                <PlatformForm op="feemerchant.register" action={ctx.action} returnTo={ctx.returnTo}>
                  <ProviderField name="provider" label="Provider" providers={providers} />
                  <TextField
                    name="merchantRef"
                    label="Merchant reference"
                    required
                    hint="The provider’s identifier, as the provider writes it."
                  />
                  <button type="submit">Register the fee merchant</button>
                </PlatformForm>
              </details>
            ) : null}
          </Section>
          <Paging
            nextHref={
              merchants.data.nextCursor
                ? accountsHref('/accounts/merchants', {
                    ...query,
                    cursor: merchants.data.nextCursor,
                  })
                : null
            }
            firstHref={accountsHref('/accounts/merchants', withoutCursor(query))}
            hasCursor={query.cursor !== undefined}
            noun="merchants"
          />
        </>
      )}
    </div>
  );
}
