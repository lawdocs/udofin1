import { AreaField, SelectField, TextField } from '../onboarding/forms.js';
import { CheckField, EmptyList, LoadFailure, Paging } from '../servicing/common.js';
import { formatDate, istOrDash } from '../servicing/format.js';
import {
  AccountsNav,
  AccountsNotice,
  LenderField,
  PlatformForm,
  SecondPerson,
  SecretField,
  Section,
  whoWords,
  type AccountsContext,
} from './common.js';
import { accountsHref, lenderLabel, withoutCursor, type AccountsQuery } from './data.js';
import {
  type KeyVersionEntry,
  type LenderChoice,
  type Loaded,
  type Page,
  type RegistryEntry,
  type RuleEntry,
} from './types.js';
import {
  evidenceStatusWords,
  EVIDENCE_STATUSES,
  keyStatusWords,
  OWNER_KINDS,
  ownerKindWords,
  PURPOSES,
  purposeWords,
  REGISTRY_STATUSES,
  registryStatusWords,
  ruleStatusWords,
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
// Whether an account can be registered at all
// ---------------------------------------------------------------------------------------------------------------
export interface RegistrationReadiness {
  /** True only when an approved format rule exists and a key version is active. */
  ready: boolean;
  /** Plain sentences saying what is missing. Empty when ready. */
  missing: string[];
  /** The country and account type of each approved rule (what an account can be registered as). */
  formats: { country: string; accountType: string }[];
  /** The proposed key version, if one waits for a second person (an entry under the active version may be re-registered). */
  proposedVersion: number | null;
  activeVersion: number | null;
}

/**
 * Registration is offered only when it can work: an approved format rule and an active fingerprint key version. The API refuses
 * it otherwise; this keeps the screen from offering a form that cannot succeed. When either fact could not be read, the form is
 * not offered either.
 */
export function registrationReadiness(
  rules: Loaded<{ items: RuleEntry[] }>,
  keys: Loaded<{ items: KeyVersionEntry[] }>,
): RegistrationReadiness {
  const missing: string[] = [];
  const formats: { country: string; accountType: string }[] = [];
  if (!rules.ok) {
    missing.push('The account format rules could not be read, so registration is not offered.');
  } else {
    for (const rule of rules.data.items) {
      if (
        rule.status === 'approved' &&
        !formats.some((f) => f.country === rule.country && f.accountType === rule.accountType)
      )
        formats.push({ country: rule.country, accountType: rule.accountType });
    }
    if (formats.length === 0)
      missing.push(
        'No account format rule is approved yet, so no account can be registered. A rule is drafted, submitted and then approved by a different person under “Format rules and key versions”.',
      );
  }
  let proposedVersion: number | null = null;
  let activeVersion: number | null = null;
  if (!keys.ok) {
    missing.push('The fingerprint key versions could not be read, so registration is not offered.');
  } else {
    activeVersion = keys.data.items.find((k) => k.status === 'active')?.keyVersion ?? null;
    proposedVersion = keys.data.items.find((k) => k.status === 'proposed')?.keyVersion ?? null;
    if (activeVersion === null)
      missing.push(
        'No fingerprint key version is active, so no account can be registered. A version is proposed and then approved by a different person.',
      );
  }
  return { ready: missing.length === 0, missing, formats, proposedVersion, activeVersion };
}

const uniq = (values: readonly string[]) => [...new Set(values)];

// ---------------------------------------------------------------------------------------------------------------
// Registering an account
// ---------------------------------------------------------------------------------------------------------------
/**
 * The only form in the portal that holds a full account number. It is typed once into a password-type field, posts to the
 * server entry point that serves this one operation, and is never shown again: the page that follows names the entry by its
 * identifier and shows the masked reference the API returned. There is no client-side state, no prefilled value and no echo.
 */
function RegisterForm({
  ctx,
  readiness,
  lenders,
}: {
  ctx: AccountsContext;
  readiness: RegistrationReadiness;
  lenders: readonly LenderChoice[] | null;
}) {
  const countries = uniq(readiness.formats.map((f) => f.country));
  const types = uniq(readiness.formats.map((f) => f.accountType));
  return (
    <PlatformForm action={ctx.registerAction} autoComplete="off">
      <p>
        You type the account number once, here. Udofin checks it against the approved rule, keeps
        only a keyed fingerprint and the masked reference (the last four digits), and never shows
        the number again. Do not copy it into any other box.
      </p>
      <SelectField
        name="country"
        label="Country"
        required
        options={countries.map((c) => ({ value: c, label: c }))}
        {...(countries.length > 1 ? { blank: 'Choose' } : {})}
      />
      <SelectField
        name="accountType"
        label="Account type"
        required
        options={types.map((t) => ({ value: t, label: t.replaceAll('_', ' ') }))}
        {...(types.length > 1 ? { blank: 'Choose' } : {})}
      />
      <SecretField
        name="accountNumber"
        label="Account number"
        inputMode="numeric"
        hint="Digits only. Typed once; it is not shown again."
      />
      <SecretField
        name="ifsc"
        label="IFSC"
        hint="Always asked for. Eleven characters; the fifth is a zero."
      />
      <SelectField
        name="ownerKind"
        label="Who owns the account"
        blank="Choose"
        required
        options={words(OWNER_KINDS, ownerKindWords)}
      />
      <LenderField
        name="ownerOrgId"
        label="Lender (only when the owner is a lender)"
        lenders={lenders}
        blank="Not a lender’s account"
        hint="Only needed when the owner is a lender. The list of lenders could not be read, so type the lender’s identifier."
      />
      <TextField
        name="legalOwnerName"
        label="Legal name of the owner"
        required
        hint="The name of an organisation, never a person. Do not type numbers that identify anyone."
      />
      <fieldset>
        <legend>What the account may be used for</legend>
        {PURPOSES.map((purpose) => (
          <CheckField
            key={purpose}
            name="permittedPurposes"
            value={purpose}
            label={purposeWords(purpose)}
          />
        ))}
      </fieldset>
      <TextField name="effectiveFrom" label="Effective from (optional)" type="date" />
      <TextField
        name="effectiveTo"
        label="Effective until (optional)"
        type="date"
        hint="The day itself is not included."
      />
      <button type="submit">Register the account</button>
      <p className="muted">
        The entry starts as unverified. A different person verifies it before anything can rely on
        it.
      </p>
    </PlatformForm>
  );
}

/** Re-registering a live entry under the proposed key version (a key rotation). The number is typed once again, for that entry. */
function RekeyForm({
  entry,
  ctx,
  version,
}: {
  entry: RegistryEntry;
  ctx: AccountsContext;
  version: number;
}) {
  return (
    <details>
      <summary>{`Re-register under key version ${String(version)}`}</summary>
      <PlatformForm
        action={ctx.registerAction}
        autoComplete="off"
        hidden={{
          rekeysRegistryId: entry.id,
          country: entry.country,
          accountType: entry.accountType,
          ownerKind: entry.ownerKind,
          ...(entry.ownerOrgId ? { ownerOrgId: entry.ownerOrgId } : {}),
          legalOwnerName: entry.legalOwnerName,
          permittedPurposes: entry.permittedPurposes,
          effectiveFrom: entry.effectiveFrom,
          ...(entry.effectiveTo ? { effectiveTo: entry.effectiveTo } : {}),
        }}
      >
        <p>
          Type the account number again for this entry. The new entry has the same owner and
          purposes and starts as unverified.
        </p>
        <SecretField
          name="accountNumber"
          label="Account number"
          inputMode="numeric"
          hint="Digits only. Typed once; it is not shown again."
        />
        <SecretField name="ifsc" label="IFSC" />
        <button type="submit">Re-register this account</button>
      </PlatformForm>
    </details>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The registry list
// ---------------------------------------------------------------------------------------------------------------
function Effective({ from, to }: { from: string; to: string | null }) {
  return (
    <>
      From {formatDate(from)}
      {to ? `, until ${formatDate(to)} (that day is not included)` : ', with no end date'}
    </>
  );
}

function ownerLine(entry: RegistryEntry, lenders: readonly LenderChoice[] | null): string {
  if (entry.ownerKind === 'lender' && entry.ownerOrgId)
    return `${ownerKindWords(entry.ownerKind)}: ${lenderLabel(lenders, entry.ownerOrgId)}`;
  return ownerKindWords(entry.ownerKind);
}

/** One registered account: the masked reference and the facts, never the number or the fingerprint. */
export function RegistryEntryCard({
  entry,
  ctx,
  lenders,
  rekeyVersion,
}: {
  entry: RegistryEntry;
  ctx: AccountsContext;
  lenders: readonly LenderChoice[] | null;
  /** The proposed key version, when an entry under the active version may be re-registered. */
  rekeyVersion?: number | null;
}) {
  const own = entry.registeredBy === ctx.userId;
  const owned = entry.ownerKind === 'udofin' || entry.ownerKind === 'group_company';
  const mayVerify = ctx.caps.registryVerify;
  const mayAct = ctx.caps.registryManage || ctx.caps.registryVerify;
  return (
    <article className="card">
      <h3>Account {entry.maskedRef}</h3>
      {owned ? (
        <p>
          <strong>{ownerKindWords(entry.ownerKind)}</strong>: this is not a lender’s account.
        </p>
      ) : null}
      <dl className="facts">
        <div>
          <dt>Status</dt>
          <dd>{registryStatusWords(entry.verificationStatus)}</dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>{ownerLine(entry, lenders)}</dd>
        </div>
        <div>
          <dt>Legal owner</dt>
          <dd>{entry.legalOwnerName}</dd>
        </div>
        <div>
          <dt>May be used for</dt>
          <dd>{entry.permittedPurposes.map(purposeWords).join(', ')}</dd>
        </div>
        <div>
          <dt>Effective</dt>
          <dd>
            <Effective from={entry.effectiveFrom} to={entry.effectiveTo} />
          </dd>
        </div>
        <div>
          <dt>Format</dt>
          <dd>
            {entry.country}, {entry.accountType.replaceAll('_', ' ')}; fingerprint key version{' '}
            {entry.keyVersion}
            {entry.rekeyedFromId ? '; re-registered from an earlier entry' : ''}
          </dd>
        </div>
        <div>
          <dt>Registered</dt>
          <dd>
            {istOrDash(entry.registeredAt)} by {whoWords(entry.registeredBy, ctx.userId)}
          </dd>
        </div>
        {entry.verifiedAt ? (
          <div>
            <dt>Verified</dt>
            <dd>
              {istOrDash(entry.verifiedAt)} by {whoWords(entry.verifiedBy, ctx.userId)}
              {entry.evidenceRef ? `; evidence: ${entry.evidenceRef}` : ''}
            </dd>
          </div>
        ) : null}
        {entry.rejectedAt ? (
          <div>
            <dt>Rejected</dt>
            <dd>
              {istOrDash(entry.rejectedAt)}
              {entry.rejectionReason ? `: ${entry.rejectionReason}` : ''}
            </dd>
          </div>
        ) : null}
        {entry.revokedAt ? (
          <div>
            <dt>Revoked</dt>
            <dd>
              {istOrDash(entry.revokedAt)}
              {entry.revokedReason ? `: ${entry.revokedReason}` : ''}
            </dd>
          </div>
        ) : null}
      </dl>

      {entry.verificationStatus === 'unverified' ? (
        mayVerify ? (
          own ? (
            <SecondPerson>
              You registered this account, so a different person must verify it.
            </SecondPerson>
          ) : (
            <details>
              <summary>Verify this account</summary>
              <PlatformForm
                op="account.verify"
                action={ctx.action}
                returnTo={ctx.returnTo}
                hidden={{ id: entry.id }}
              >
                <TextField
                  name="evidenceRef"
                  label="Reference to the evidence you checked"
                  required
                  hint="A short title or reference of the document, not its contents, and no long numbers."
                />
                <AreaField name="note" label="Note (optional)" />
                <button type="submit">Verify the account</button>
              </PlatformForm>
            </details>
          )
        ) : (
          <SecondPerson>Your role cannot verify accounts.</SecondPerson>
        )
      ) : null}

      {mayAct && entry.verificationStatus === 'unverified' ? (
        <details>
          <summary>Reject this entry</summary>
          <PlatformForm
            op="account.reject"
            action={ctx.action}
            returnTo={ctx.returnTo}
            hidden={{ id: entry.id }}
          >
            <AreaField
              name="reason"
              label="Reason"
              required
              hint="At least 10 characters. Do not type account, phone or identity numbers."
            />
            <button type="submit">Reject the entry</button>
          </PlatformForm>
        </details>
      ) : null}

      {mayAct &&
      (entry.verificationStatus === 'unverified' || entry.verificationStatus === 'verified') ? (
        <details>
          <summary>Revoke this entry</summary>
          <PlatformForm
            op="account.revoke"
            action={ctx.action}
            returnTo={ctx.returnTo}
            hidden={{ id: entry.id }}
          >
            <p>
              Revoking also revokes the lender settlement accounts linked to this entry and suspends
              the active payment configurations that settle into them.
            </p>
            <AreaField
              name="reason"
              label="Reason"
              required
              hint="At least 10 characters. Do not type account, phone or identity numbers."
            />
            <button type="submit">Revoke the entry</button>
          </PlatformForm>
        </details>
      ) : null}

      {ctx.caps.registryManage &&
      rekeyVersion !== null &&
      rekeyVersion !== undefined &&
      entry.keyVersion !== rekeyVersion &&
      (entry.verificationStatus === 'unverified' || entry.verificationStatus === 'verified') ? (
        <RekeyForm entry={entry} ctx={ctx} version={rekeyVersion} />
      ) : null}
    </article>
  );
}

export function RegistryPage({
  accounts,
  registered,
  rules,
  keys,
  lenders,
  query,
  ctx,
  notice,
}: {
  accounts: Loaded<Page<RegistryEntry>>;
  /** The entry that was just registered, read back from the API by its identifier; null when none was. */
  registered: Loaded<RegistryEntry> | null;
  rules: Loaded<{ items: RuleEntry[] }> | null;
  keys: Loaded<{ items: KeyVersionEntry[] }> | null;
  lenders: readonly LenderChoice[] | null;
  query: AccountsQuery;
  ctx: AccountsContext;
  notice: Notice;
}) {
  const readiness =
    rules && keys
      ? registrationReadiness(rules, keys)
      : ({
          ready: false,
          missing: ['The facts needed to register an account could not be read.'],
          formats: [],
          proposedVersion: null,
          activeVersion: null,
        } satisfies RegistrationReadiness);
  return (
    <div>
      <h1>Account registry</h1>
      <AccountsNav current="/accounts" />
      <p>
        The accounts Udofin knows about, kept as a masked reference (the last four digits) and a
        keyed fingerprint. Udofin’s own and group accounts are marked. A lender settlement account
        can only be linked to a verified entry that the same lender owns.
      </p>
      <AccountsNotice {...notice} />
      {registered ? (
        registered.ok ? (
          <p role="status">
            The account was registered with the reference {registered.data.maskedRef}. Its status
            is: {registryStatusWords(registered.data.verificationStatus)}.
          </p>
        ) : (
          <p role="status">
            The account was registered, but the entry could not be read back just now. Find it in
            the list below.
          </p>
        )
      ) : null}

      {ctx.caps.registryManage ? (
        <Section title="Register an account">
          {readiness.ready ? (
            <RegisterForm ctx={ctx} readiness={readiness} lenders={lenders} />
          ) : (
            <ul>
              {readiness.missing.map((sentence) => (
                <li key={sentence}>{sentence}</li>
              ))}
            </ul>
          )}
        </Section>
      ) : (
        <p className="muted">Your role cannot register accounts.</p>
      )}

      <Section title="Registered accounts">
        <form method="get" action="/accounts" className="inline">
          <SelectField
            name="status"
            label="Status"
            blank="All"
            options={words(REGISTRY_STATUSES, registryStatusWords)}
            defaultValue={query.status ?? ''}
          />
          <LenderField
            name="lenderId"
            label="Owned by lender"
            lenders={lenders}
            defaultValue={query.lenderId}
            blank="Any owner"
          />
          <button type="submit" className="secondary">
            Show
          </button>
        </form>
        {!accounts.ok ? (
          <LoadFailure what="the registered accounts" status={accounts.status} />
        ) : accounts.data.items.length === 0 ? (
          <EmptyList
            title="No registered accounts"
            detail="Nothing matches this filter, or no account has been registered yet."
          />
        ) : (
          <>
            {accounts.data.items.map((entry) => (
              <RegistryEntryCard
                key={entry.id}
                entry={entry}
                ctx={ctx}
                lenders={lenders}
                rekeyVersion={readiness.proposedVersion}
              />
            ))}
            <Paging
              nextHref={
                accounts.data.nextCursor
                  ? accountsHref('/accounts', { ...query, cursor: accounts.data.nextCursor })
                  : null
              }
              firstHref={accountsHref('/accounts', withoutCursor(query))}
              hasCursor={query.cursor !== undefined}
              noun="accounts"
            />
          </>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Format rules and fingerprint key versions
// ---------------------------------------------------------------------------------------------------------------
function RuleCard({ rule, ctx }: { rule: RuleEntry; ctx: AccountsContext }) {
  const drafter = rule.draftedBy === ctx.userId;
  const proposer = rule.submittedBy === ctx.userId;
  const unsourced = rule.evidenceLabel === 'unverified';
  return (
    <article className="card">
      <h3>
        {rule.country}, {rule.accountType.replaceAll('_', ' ')}, version {rule.version}
      </h3>
      <dl className="facts">
        <div>
          <dt>Status</dt>
          <dd>{ruleStatusWords(rule.status)}</dd>
        </div>
        <div>
          <dt>Source of the rule</dt>
          <dd>
            {evidenceStatusWords(rule.evidenceLabel)}
            {rule.sourceNote ? `. Note: ${rule.sourceNote}` : ''}
          </dd>
        </div>
        <div>
          <dt>Length of the number</dt>
          <dd>
            {rule.minDigits} to {rule.maxDigits} digits, as recorded in this rule
            {unsourced ? ' (unverified)' : ''}
          </dd>
        </div>
        <div>
          <dt>IFSC</dt>
          <dd>{rule.ifscRequired ? 'Recorded as required' : 'Recorded as not required'}</dd>
        </div>
        <div>
          <dt>Effective</dt>
          <dd>
            <Effective from={rule.effectiveFrom} to={rule.effectiveTo} />
          </dd>
        </div>
        <div>
          <dt>Drafted</dt>
          <dd>
            {istOrDash(rule.createdAt)} by {whoWords(rule.draftedBy, ctx.userId)}
          </dd>
        </div>
        {rule.submittedBy ? (
          <div>
            <dt>Proposed by</dt>
            <dd>{whoWords(rule.submittedBy, ctx.userId)}</dd>
          </div>
        ) : null}
        {rule.approvedAt ? (
          <div>
            <dt>Approved</dt>
            <dd>
              {istOrDash(rule.approvedAt)} by {whoWords(rule.approvedBy, ctx.userId)}
            </dd>
          </div>
        ) : null}
        {rule.retiredAt ? (
          <div>
            <dt>Retired</dt>
            <dd>
              {istOrDash(rule.retiredAt)}
              {rule.retiredReason ? `: ${rule.retiredReason}` : ''}
            </dd>
          </div>
        ) : null}
      </dl>
      {rule.status === 'approved' && unsourced ? (
        <p role="note">
          This rule is approved as a decision of the platform team. Its evidence label is still
          unverified: no source has been supplied, so the approval is a recorded decision, not
          evidence.
        </p>
      ) : null}

      {rule.status === 'draft' && rule.submittedBy === null ? (
        ctx.caps.registryManage ? (
          <PlatformForm
            op="rule.submit"
            action={ctx.action}
            returnTo={ctx.returnTo}
            hidden={{ id: rule.id }}
          >
            <button type="submit">Propose this rule for approval</button>
          </PlatformForm>
        ) : (
          <SecondPerson>Your role cannot propose rules.</SecondPerson>
        )
      ) : null}

      {rule.status === 'draft' && rule.submittedBy !== null ? (
        ctx.caps.registryVerify ? (
          drafter || proposer ? (
            <SecondPerson>
              You drafted or proposed this rule, so a different person must approve it.
            </SecondPerson>
          ) : (
            <PlatformForm
              op="rule.approve"
              action={ctx.action}
              returnTo={ctx.returnTo}
              hidden={{ id: rule.id }}
            >
              <AreaField name="note" label="Note (optional)" />
              <button type="submit">Approve this rule</button>
            </PlatformForm>
          )
        ) : (
          <SecondPerson>Waiting for a different person to approve it.</SecondPerson>
        )
      ) : null}

      {(rule.status === 'draft' || rule.status === 'approved') &&
      (ctx.caps.registryManage || ctx.caps.registryVerify) ? (
        <details>
          <summary>Retire this rule</summary>
          <PlatformForm
            op="rule.retire"
            action={ctx.action}
            returnTo={ctx.returnTo}
            hidden={{ id: rule.id }}
          >
            <AreaField
              name="reason"
              label="Reason"
              required
              hint="At least 10 characters. Do not type account, phone or identity numbers."
            />
            <button type="submit">Retire the rule</button>
          </PlatformForm>
        </details>
      ) : null}
    </article>
  );
}

function KeyCard({ version, ctx }: { version: KeyVersionEntry; ctx: AccountsContext }) {
  return (
    <article className="card">
      <h3>Key version {version.keyVersion}</h3>
      <dl className="facts">
        <div>
          <dt>Status</dt>
          <dd>{keyStatusWords(version.status)}</dd>
        </div>
        <div>
          <dt>Proposed</dt>
          <dd>
            {istOrDash(version.proposedAt)} by {whoWords(version.proposedBy, ctx.userId)}
          </dd>
        </div>
        {version.approvedAt ? (
          <div>
            <dt>Approved</dt>
            <dd>
              {istOrDash(version.approvedAt)} by {whoWords(version.approvedBy, ctx.userId)}
            </dd>
          </div>
        ) : null}
        {version.retiredAt ? (
          <div>
            <dt>Retired</dt>
            <dd>{istOrDash(version.retiredAt)}</dd>
          </div>
        ) : null}
        {version.note ? (
          <div>
            <dt>Note</dt>
            <dd>{version.note}</dd>
          </div>
        ) : null}
      </dl>
      {version.status === 'proposed' ? (
        ctx.caps.registryVerify ? (
          version.proposedBy === ctx.userId ? (
            <SecondPerson>
              You proposed this version, so a different person must approve it.
            </SecondPerson>
          ) : (
            <PlatformForm
              op="keyversion.approve"
              action={ctx.action}
              returnTo={ctx.returnTo}
              hidden={{ version: String(version.keyVersion) }}
            >
              <AreaField name="note" label="Note (optional)" />
              <button type="submit">Approve this key version</button>
            </PlatformForm>
          )
        ) : (
          <SecondPerson>Waiting for a different person to approve it.</SecondPerson>
        )
      ) : null}
    </article>
  );
}

export function RulesPage({
  rules,
  keys,
  query,
  ctx,
  notice,
}: {
  rules: Loaded<{ items: RuleEntry[] }>;
  keys: Loaded<{ items: KeyVersionEntry[] }>;
  query: AccountsQuery;
  ctx: AccountsContext;
  notice: Notice;
}) {
  const proposalOpen = keys.ok && keys.data.items.some((k) => k.status === 'proposed');
  return (
    <div>
      <h1>Format rules and key versions</h1>
      <AccountsNav current="/accounts/rules" />
      <p>
        An account can only be registered when a format rule is approved and a fingerprint key
        version is active. Each takes two different people. The key itself is never shown here.
      </p>
      <AccountsNotice {...notice} />

      <Section title="Account format rules">
        <form method="get" action="/accounts/rules" className="inline">
          <SelectField
            name="status"
            label="Status"
            blank="All"
            options={words(['draft', 'approved', 'retired'], ruleStatusWords)}
            defaultValue={query.status ?? ''}
          />
          <button type="submit" className="secondary">
            Show
          </button>
        </form>
        {!rules.ok ? (
          <LoadFailure what="the format rules" status={rules.status} />
        ) : rules.data.items.length === 0 ? (
          <EmptyList title="No rules" detail="No format rule matches this filter." />
        ) : (
          rules.data.items.map((rule) => <RuleCard key={rule.id} rule={rule} ctx={ctx} />)
        )}
        {ctx.caps.registryManage ? (
          <details>
            <summary>Draft a new rule</summary>
            <PlatformForm op="rule.draft" action={ctx.action} returnTo={ctx.returnTo}>
              <TextField name="country" label="Country" required hint="Two capital letters." />
              <TextField
                name="accountType"
                label="Account type"
                required
                hint="Lower-case letters, digits and underscores."
              />
              <TextField name="minDigits" label="Shortest number (digits)" required />
              <TextField name="maxDigits" label="Longest number (digits)" required />
              <SelectField
                name="ifscRequired"
                label="Is the IFSC required"
                blank="Choose"
                required
                options={[
                  { value: 'yes', label: 'Yes' },
                  { value: 'no', label: 'No' },
                ]}
              />
              <SelectField
                name="evidenceLabel"
                label="What staff know about the source"
                blank="Choose"
                required
                options={words(EVIDENCE_STATUSES, evidenceStatusWords)}
              />
              <AreaField
                name="sourceNote"
                label="Where the rule comes from"
                required
                hint="10 to 500 characters. Name the document; do not paste numbers that identify anyone."
              />
              <TextField name="effectiveFrom" label="Effective from (optional)" type="date" />
              <TextField name="effectiveTo" label="Effective until (optional)" type="date" />
              <button type="submit">Draft the rule</button>
            </PlatformForm>
          </details>
        ) : (
          <p className="muted">Your role cannot draft rules.</p>
        )}
      </Section>

      <Section title="Fingerprint key versions">
        {!keys.ok ? (
          <LoadFailure what="the key versions" status={keys.status} />
        ) : keys.data.items.length === 0 ? (
          <EmptyList
            title="No key versions"
            detail="None has been proposed yet, so no account can be registered."
          />
        ) : (
          keys.data.items.map((version) => (
            <KeyCard key={version.keyVersion} version={version} ctx={ctx} />
          ))
        )}
        {ctx.caps.registryManage ? (
          proposalOpen ? (
            <SecondPerson>
              A version is already proposed. Decide it before proposing another.
            </SecondPerson>
          ) : (
            <details>
              <summary>Propose a key version</summary>
              <PlatformForm op="keyversion.propose" action={ctx.action} returnTo={ctx.returnTo}>
                <TextField
                  name="version"
                  label="Version number"
                  required
                  hint="A whole number. The key for it must already be held in the key service."
                />
                <AreaField name="note" label="Note (optional)" />
                <button type="submit">Propose the version</button>
              </PlatformForm>
            </details>
          )
        ) : (
          <p className="muted">Your role cannot propose key versions.</p>
        )}
      </Section>
    </div>
  );
}
