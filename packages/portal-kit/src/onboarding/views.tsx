import {
  ACCOUNTING_FRAMEWORKS,
  APPLICABILITY_BASES,
  CONFIRMATION_SOURCES,
  CONTRACT_TYPES,
  DOCUMENT_PURPOSES,
  GATE_SEQUENCE,
  IND_AS_APPLICABILITY,
  IND_AS_IMPLEMENTATION,
  INTEGRATION_KINDS,
  LICENCE_STATUSES,
  LISTED_STATUSES,
  RESPONSIBLE_PARTIES,
  STATEMENT_SCOPES,
  SYSTEMS_OF_RECORD,
  type AccountingProfile,
  type DocumentRecord,
  type InstitutionCategoryList,
  type LenderService,
  type LenderSummary,
  type Requirement,
  type ServiceVersion,
} from '@udofin/contracts';
import { type ReactNode } from 'react';
import { type PortalKind } from './api.js';
import {
  type Capabilities,
  type Loaded,
  type Tab,
  type TabData,
  TAB_LABELS,
  TABS,
} from './data.js';
import { AreaField, OpForm, SelectField, TextField, type FormAction } from './forms.js';
import { errorMessage, label } from './labels.js';
import { ErrorState, EmptyState } from '../states.js';

export interface ViewContext {
  portal: PortalKind;
  caps: Capabilities;
  action: FormAction;
  /** Page the action returns to. */
  returnTo: string;
  /** The signed-in person, used only to hide controls they could not use (the API decides). */
  userId?: string;
}

const options = (values: readonly string[]) => values.map((v) => ({ value: v, label: label(v) }));
const date = (value: string | null | undefined) => (value ? value.slice(0, 10) : '—');
const stamp = (value: string | null | undefined) =>
  value ? value.slice(0, 16).replace('T', ' ') : '—';

export function Notice({ done, error }: { done?: boolean; error?: string | undefined }) {
  if (error)
    return (
      <p role="alert" className="form-error">
        {errorMessage(error)}
      </p>
    );
  if (done) return <p role="status">Saved.</p>;
  return null;
}

function Loadable<T>({
  result,
  title,
  children,
}: {
  result: { ok: true; data: T } | { ok: false; code: string; status: number } | undefined;
  title: string;
  children: (data: T) => ReactNode;
}) {
  if (!result) return null;
  if (!result.ok) {
    return (
      <ErrorState
        title={result.status === 403 ? `You cannot view ${title}` : `Could not load ${title}`}
        detail={result.status === 403 ? 'Your role does not include this.' : 'Reload the page.'}
      />
    );
  }
  return <>{children(result.data)}</>;
}

function Dl({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {rows.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function StageTracker({ stage }: { stage: string }) {
  const index = (GATE_SEQUENCE as readonly string[]).indexOf(stage);
  const sideState = index < 0;
  return (
    <section aria-label="Activation stage" className="card">
      <h2>Activation stage</h2>
      <ol className="stages">
        {GATE_SEQUENCE.map((s, i) => (
          <li
            key={s}
            aria-current={i === index ? 'step' : undefined}
            className={i < index ? 'done' : i === index ? 'current' : ''}
          >
            {label(s)}
            <span className="sr-only">
              {i < index ? ' (complete)' : i === index ? ' (current)' : ' (not reached)'}
            </span>
          </li>
        ))}
      </ol>
      {sideState ? (
        <p role="status">
          Current state: <strong>{label(stage)}</strong>
        </p>
      ) : null}
      <p className="muted">
        Each step is requested by one person and decided by another. Approving a lender does not
        approve its products, services, integrations or commercial terms; those have their own
        steps.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
export function LendersTable({
  lenders,
  base,
}: {
  lenders: readonly LenderSummary[];
  base: string;
}) {
  if (lenders.length === 0) {
    return <EmptyState title="No lenders" detail="Lenders you can see will appear here." />;
  }
  return (
    <table>
      <caption className="sr-only">Lenders in onboarding</caption>
      <thead>
        <tr>
          <th scope="col">Lender</th>
          <th scope="col">Category</th>
          <th scope="col">Stage</th>
          <th scope="col">Institution</th>
          <th scope="col">Accounting record</th>
        </tr>
      </thead>
      <tbody>
        {lenders.map((l) => (
          <tr key={l.lenderOrgId}>
            <th scope="row">
              <a href={`${base}/${l.lenderOrgId}`}>{l.displayName}</a>
              <div className="muted">{l.legalName}</div>
            </th>
            <td>{l.categoryLabel ?? 'No profile yet'}</td>
            <td>{l.stage ? label(l.stage) : '—'}</td>
            <td>{label(l.verificationStatus)}</td>
            <td>{label(l.accountingStatus)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CreateProfileForm({
  lenders,
  categories,
  ctx,
}: {
  lenders: readonly LenderSummary[];
  categories: readonly { key: string; label: string }[];
  ctx: ViewContext;
}) {
  const without = lenders.filter((l) => !l.categoryKey);
  if (!ctx.caps.manage || without.length === 0) return null;
  return (
    <section className="card">
      <h2>Create an institution profile</h2>
      <p className="muted">
        A profile records what is known about the lender. It does not approve, verify or activate
        anything. The lender organisation itself is created through a change request.
      </p>
      <OpForm
        op="profile.create"
        action={ctx.action}
        returnTo={ctx.returnTo}
        submit="Create profile"
      >
        <SelectField
          name="lenderOrgId"
          label="Lender"
          required
          options={without.map((l) => ({ value: l.lenderOrgId, label: l.displayName }))}
        />
        <SelectField
          name="categoryKey"
          label="Institution category"
          required
          options={categories.map((c) => ({ value: c.key, label: c.label }))}
        />
        <TextField name="registrationNo" label="Regulator registration number" />
        <TextField name="licenceType" label="Licence / registration type" />
        <SelectField
          name="licenceStatus"
          label="Licence status (as declared)"
          blank="Unknown"
          options={options(LICENCE_STATUSES.filter((s) => s !== 'unknown'))}
        />
      </OpForm>
    </section>
  );
}

export function TabNav({
  base,
  lenderId,
  current,
}: {
  base: string;
  lenderId: string;
  current: Tab;
}) {
  return (
    <nav aria-label="Onboarding sections" className="tabs">
      <ul>
        {TABS.map((t) => (
          <li key={t}>
            <a
              href={`${base}/${lenderId}?tab=${t}`}
              aria-current={t === current ? 'page' : undefined}
            >
              {TAB_LABELS[t]}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function DocumentOptions(documents: readonly DocumentRecord[]) {
  return documents.map((d) => ({ value: d.id, label: `${d.label} (${date(d.uploadedAt)})` }));
}

// ---------------------------------------------------------------------------------------------
export function ProfileTab({
  data,
  lenderId,
  ctx,
}: {
  data: TabData;
  lenderId: string;
  ctx: ViewContext;
}) {
  const documents = data.documents?.ok ? data.documents.data.items : [];
  const categories = data.categories?.ok ? data.categories.data.items : [];
  return (
    <Loadable result={data.overview} title="the lender">
      {(o) => {
        const p = o.profile;
        if (!p) {
          return (
            <EmptyState
              title="No institution profile yet"
              detail="Udofin onboarding staff create the profile from the onboarding list."
            />
          );
        }
        const category = categories.find((c) => c.key === p.categoryKey);
        return (
          <>
            <section className="card">
              <h2>Institution profile</h2>
              <Dl
                rows={[
                  ['Category', category?.label ?? label(p.categoryKey)],
                  ['Regulator', p.regulator],
                  ['Registration number', p.registrationNo],
                  ['CIN', p.cin],
                  ['Licence type', p.licenceType],
                  ['Licence status (as declared)', label(p.licenceStatus)],
                  ['Licence valid until', date(p.licenceValidUntil)],
                  ['Notes', p.notes],
                ]}
              />
              {category && category.regimeStatus !== 'confirmed_primary' ? (
                <p role="note" className="muted">
                  Regulatory basis for this category:{' '}
                  <strong>{label(category.regimeStatus)}</strong>. {category.regimeNote}{' '}
                  {o.categoryActivationAllowed
                    ? 'Compliance has signed this category off for activation.'
                    : 'It cannot be activated until compliance signs it off.'}
                </p>
              ) : null}
            </section>

            <section className="card">
              <h2>Verification</h2>
              <p>
                Status: <strong>{label(p.verificationStatus)}</strong>
                {p.lastVerifiedOn ? ` — last verified ${date(p.lastVerifiedOn)}` : ''}
              </p>
              <p className="muted">
                Verified means an independent reviewer checked evidence. A profile is never treated
                as verified just because it exists, and changing identity details withdraws
                verification.
              </p>
              {p.verificationNote ? <p>Reviewer note: {p.verificationNote}</p> : null}
              {(ctx.caps.submit || ctx.caps.manage) &&
              ['unverified', 'rejected', 'expired'].includes(p.verificationStatus) ? (
                <OpForm
                  op="verification.submit"
                  action={ctx.action}
                  returnTo={ctx.returnTo}
                  hidden={{ lenderId }}
                  submit="Submit evidence for verification"
                >
                  <SelectField
                    name="evidenceDocumentId"
                    label="Evidence document (upload it under Documents first)"
                    required
                    options={DocumentOptions(documents)}
                  />
                </OpForm>
              ) : null}
              {ctx.caps.approve && p.verificationStatus === 'submitted' ? (
                <>
                  <OpForm
                    op="verification.decide"
                    action={ctx.action}
                    returnTo={ctx.returnTo}
                    hidden={{ lenderId, approve: 'true' }}
                    submit="Verify"
                  >
                    <TextField name="reverifyBy" label="Re-verify by" type="date" />
                    <TextField name="note" label="Note on the evidence reviewed" />
                  </OpForm>
                  <OpForm
                    op="verification.decide"
                    action={ctx.action}
                    returnTo={ctx.returnTo}
                    hidden={{ lenderId, approve: 'false' }}
                    submit="Reject"
                    secondary
                  >
                    <TextField name="note" label="Reason (required)" required />
                  </OpForm>
                </>
              ) : null}
            </section>

            {ctx.caps.submit || ctx.caps.manage ? (
              <section className="card">
                <h2>Correct profile details</h2>
                <OpForm
                  op="profile.update"
                  action={ctx.action}
                  returnTo={ctx.returnTo}
                  hidden={{ lenderId }}
                  submit="Save details"
                >
                  <TextField
                    name="registrationNo"
                    label="Registration number"
                    defaultValue={p.registrationNo}
                  />
                  <TextField name="cin" label="CIN" defaultValue={p.cin} />
                  <TextField name="licenceType" label="Licence type" defaultValue={p.licenceType} />
                  <TextField
                    name="licenceValidUntil"
                    label="Licence valid until"
                    type="date"
                    defaultValue={p.licenceValidUntil}
                  />
                  <SelectField
                    name="licenceStatus"
                    label="Licence status (as declared)"
                    options={options(LICENCE_STATUSES)}
                    defaultValue={p.licenceStatus}
                  />
                  {ctx.caps.manage ? (
                    <SelectField
                      name="categoryKey"
                      label="Institution category"
                      options={categories.map((c) => ({ value: c.key, label: c.label }))}
                      defaultValue={p.categoryKey}
                    />
                  ) : null}
                </OpForm>
              </section>
            ) : null}

            <Loadable result={data.history} title="verification history">
              {(h) => (
                <section className="card">
                  <h2>Verification history</h2>
                  <table>
                    <caption className="sr-only">Every verification state, newest first</caption>
                    <thead>
                      <tr>
                        <th scope="col">When</th>
                        <th scope="col">Subject</th>
                        <th scope="col">State</th>
                        <th scope="col">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {h.items.map((e) => (
                        <tr key={e.id}>
                          <td>{stamp(e.recordedAt)}</td>
                          <td>{label(e.subject)}</td>
                          <td>{label(e.status)}</td>
                          <td>{e.note ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}
            </Loadable>
          </>
        );
      }}
    </Loadable>
  );
}

// ---------------------------------------------------------------------------------------------
function AccountingView({ v }: { v: AccountingProfile }) {
  return (
    <Dl
      rows={[
        ['Accounting framework', label(v.accountingFramework)],
        ['Ind AS applicability', label(v.indAsApplicability)],
        ['Ind AS implementation status', label(v.indAsImplementationStatus)],
        ['Basis for applicability', label(v.applicabilityBasis)],
        ['Basis note', v.applicabilityBasisNote],
        ['Financial year / effective date', `${v.effectiveFy ?? '—'} / ${date(v.effectiveDate)}`],
        ['Statement scope', label(v.statementScope)],
        ['Listed status', label(v.listedStatus)],
        ['Group relationships', v.groupRelationships],
        ['Net worth (₹, as declared)', v.netWorthPaise ? formatRupees(v.netWorthPaise) : '—'],
        ['Net worth measured on / FY', `${date(v.netWorthMeasuredOn)} / ${v.netWorthFy ?? '—'}`],
        ['Confirmation source', label(v.confirmationSource)],
        ['Notes', v.notes],
        ['Next review', date(v.nextReviewOn)],
        ['Last verified', date(v.lastVerifiedOn)],
      ]}
    />
  );
}

/** Integer paise to a rupee string without floating point. */
export function formatRupees(paise: string): string {
  const padded = paise.padStart(3, '0');
  const whole = padded.slice(0, -2);
  const frac = padded.slice(-2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}.${frac}`;
}

export function AccountingTab({
  data,
  lenderId,
  ctx,
}: {
  data: TabData;
  lenderId: string;
  ctx: ViewContext;
}) {
  const documents = data.documents?.ok ? data.documents.data.items : [];
  return (
    <Loadable result={data.accounting} title="the accounting record">
      {(a) => {
        const verified = a.items.find((v) => v.status === 'verified');
        const open = a.items.find((v) => v.status === 'draft' || v.status === 'submitted');
        const base = open ?? a.items[0];
        return (
          <>
            <p role="note" className="muted">
              This section records what the lender declares about its accounting framework and Ind
              AS position, and what evidence a reviewer checked. Applicability and implementation
              are recorded separately, and nothing is worked out from lender type, net worth or
              listing. It is not an accounting opinion and not proof of compliance.
            </p>
            <section className="card">
              <h2>Verified record</h2>
              {verified ? (
                <>
                  <p>
                    Version {verified.versionNo}, verified {date(verified.lastVerifiedOn)}.
                  </p>
                  <AccountingView v={verified} />
                </>
              ) : (
                <p role="status">
                  <strong>No verified record.</strong> The values below, if any, are declarations
                  that nobody has confirmed against evidence.
                </p>
              )}
            </section>

            {open ? (
              <section className="card">
                <h2>
                  Version {open.versionNo} ({label(open.status)})
                </h2>
                <AccountingView v={open} />
                {open.status === 'draft' && (ctx.caps.submit || ctx.caps.manage) ? (
                  <OpForm
                    op="accounting.submit"
                    action={ctx.action}
                    returnTo={ctx.returnTo}
                    hidden={{ id: open.id }}
                    submit="Submit for independent review"
                  />
                ) : null}
                {open.status === 'submitted' && ctx.caps.approve ? (
                  <>
                    <OpForm
                      op="accounting.decide"
                      action={ctx.action}
                      returnTo={ctx.returnTo}
                      hidden={{ id: open.id, approve: 'true' }}
                      submit="Verify"
                    >
                      <TextField name="note" label="Evidence reviewed and conclusion" />
                    </OpForm>
                    <OpForm
                      op="accounting.decide"
                      action={ctx.action}
                      returnTo={ctx.returnTo}
                      hidden={{ id: open.id, approve: 'false' }}
                      submit="Reject"
                      secondary
                    >
                      <TextField name="note" label="Reason (required)" required />
                    </OpForm>
                  </>
                ) : null}
              </section>
            ) : null}

            {(!open || open.status === 'draft') && (ctx.caps.submit || ctx.caps.manage) ? (
              <section className="card">
                <h2>{open ? 'Edit the draft' : 'Start a new version'}</h2>
                <OpForm
                  op="accounting.save"
                  action={ctx.action}
                  returnTo={ctx.returnTo}
                  hidden={{ lenderId }}
                  submit="Save draft"
                >
                  <SelectField
                    name="accountingFramework"
                    label="Accounting framework"
                    options={options(ACCOUNTING_FRAMEWORKS)}
                    defaultValue={base?.accountingFramework ?? 'to_be_confirmed'}
                  />
                  <SelectField
                    name="indAsApplicability"
                    label="Ind AS applicability"
                    options={options(IND_AS_APPLICABILITY)}
                    defaultValue={base?.indAsApplicability ?? 'to_be_confirmed'}
                  />
                  <SelectField
                    name="indAsImplementationStatus"
                    label="Ind AS implementation status"
                    options={options(IND_AS_IMPLEMENTATION)}
                    defaultValue={base?.indAsImplementationStatus ?? 'to_be_confirmed'}
                  />
                  <SelectField
                    name="applicabilityBasis"
                    label="Basis for applicability"
                    options={options(APPLICABILITY_BASES)}
                    defaultValue={base?.applicabilityBasis ?? 'to_be_confirmed'}
                  />
                  <AreaField
                    name="applicabilityBasisNote"
                    label="Basis note"
                    defaultValue={base?.applicabilityBasisNote}
                  />
                  <TextField
                    name="effectiveFy"
                    label="Financial year (e.g. 2026-27)"
                    defaultValue={base?.effectiveFy}
                  />
                  <TextField
                    name="effectiveDate"
                    label="Effective date"
                    type="date"
                    defaultValue={base?.effectiveDate}
                  />
                  <SelectField
                    name="statementScope"
                    label="Statement scope"
                    options={options(STATEMENT_SCOPES)}
                    defaultValue={base?.statementScope ?? 'to_be_confirmed'}
                  />
                  <SelectField
                    name="listedStatus"
                    label="Listed status"
                    options={options(LISTED_STATUSES)}
                    defaultValue={base?.listedStatus ?? 'to_be_confirmed'}
                  />
                  <AreaField
                    name="groupRelationships"
                    label="Holding / subsidiary / group relationships"
                    defaultValue={base?.groupRelationships}
                  />
                  <TextField
                    name="netWorthPaise"
                    label="Net worth in paise (whole number)"
                    defaultValue={base?.netWorthPaise}
                    hint="Integer paise, e.g. ₹5 crore is 50000000000. Recorded for reference; it does not decide applicability."
                  />
                  <TextField
                    name="netWorthMeasuredOn"
                    label="Net worth measured on"
                    type="date"
                    defaultValue={base?.netWorthMeasuredOn}
                  />
                  <TextField
                    name="netWorthFy"
                    label="Net worth financial year"
                    defaultValue={base?.netWorthFy}
                  />
                  <SelectField
                    name="confirmationSource"
                    label="Source of confirmation"
                    options={options(CONFIRMATION_SOURCES)}
                    defaultValue={base?.confirmationSource ?? 'to_be_confirmed'}
                  />
                  <SelectField
                    name="evidenceDocumentId"
                    label="Evidence document"
                    blank="Keep current / none"
                    options={DocumentOptions(documents)}
                    defaultValue={base?.evidenceDocumentId}
                  />
                  <AreaField name="notes" label="Notes" defaultValue={base?.notes} />
                  <TextField
                    name="nextReviewOn"
                    label="Next review date"
                    type="date"
                    defaultValue={base?.nextReviewOn}
                  />
                </OpForm>
              </section>
            ) : null}

            <WaiverSection data={data} lenderId={lenderId} ctx={ctx} />
            <section className="card">
              <h2>All versions</h2>
              <table>
                <caption className="sr-only">Accounting record versions, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Version</th>
                    <th scope="col">Status</th>
                    <th scope="col">Ind AS applicability</th>
                    <th scope="col">Implementation</th>
                    <th scope="col">Source</th>
                    <th scope="col">Last verified</th>
                  </tr>
                </thead>
                <tbody>
                  {a.items.map((v) => (
                    <tr key={v.id}>
                      <th scope="row">{v.versionNo}</th>
                      <td>{label(v.status)}</td>
                      <td>{label(v.indAsApplicability)}</td>
                      <td>{label(v.indAsImplementationStatus)}</td>
                      <td>{label(v.confirmationSource)}</td>
                      <td>{date(v.lastVerifiedOn)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        );
      }}
    </Loadable>
  );
}

// ---------------------------------------------------------------------------------------------
function ServiceFields({ v, ctx }: { v?: ServiceVersion | undefined; ctx: ViewContext }) {
  const udofin = ctx.caps.manage;
  return (
    <>
      <AreaField
        name="requestedScope"
        label="Requested scope (what the lender asks for)"
        defaultValue={v?.requestedScope}
      />
      {udofin ? (
        <>
          <AreaField
            name="proposedScope"
            label="Udofin proposed scope"
            defaultValue={v?.proposedScope}
          />
          <AreaField
            name="agreedScope"
            label="Final agreed scope"
            defaultValue={v?.agreedScope}
            hint="Both sides agree to exactly this text."
          />
          <SelectField
            name="responsibleParty"
            label="Responsible party"
            options={options(RESPONSIBLE_PARTIES)}
            defaultValue={v?.responsibleParty ?? 'lender'}
          />
          <SelectField
            name="accountableParty"
            label="Accountable party"
            options={options(['lender', 'udofin', 'third_party'])}
            defaultValue={v?.accountableParty ?? 'lender'}
          />
          <fieldset>
            <legend>Supporting parties</legend>
            {['lender', 'udofin', 'third_party'].map((p) => (
              <label key={p}>
                <input
                  type="checkbox"
                  name="supportingParties"
                  value={p}
                  defaultChecked={v?.supportingParties.includes(p) ?? false}
                />{' '}
                {label(p)}
              </label>
            ))}
          </fieldset>
          <AreaField
            name="sharedAllocation"
            label="If responsibility is shared: who does what"
            defaultValue={v?.sharedAllocation}
            hint="Required whenever anything is shared."
          />
          <AreaField name="dataExchanged" label="Data exchanged" defaultValue={v?.dataExchanged} />
          <AreaField
            name="permittedPurpose"
            label="Permitted purpose of that data"
            defaultValue={v?.permittedPurpose}
          />
          <AreaField name="slaSummary" label="Service levels" defaultValue={v?.slaSummary} />
          <TextField
            name="contractReference"
            label="Contract reference"
            defaultValue={v?.contractReference}
          />
          <TextField
            name="effectiveFrom"
            label="Effective from"
            type="date"
            defaultValue={v?.effectiveFrom}
          />
          <TextField name="reviewOn" label="Review on" type="date" defaultValue={v?.reviewOn} />
        </>
      ) : null}
      <AreaField
        name="prerequisites"
        label="Prerequisites the lender provides"
        defaultValue={v?.prerequisites}
      />
      <SelectField
        name="systemOfRecord"
        label="System of record"
        options={options(SYSTEMS_OF_RECORD)}
        defaultValue={v?.systemOfRecord ?? 'to_be_confirmed'}
      />
      <AreaField
        name="integrationRequirements"
        label="Integration requirements"
        defaultValue={v?.integrationRequirements}
      />
      <AreaField name="escalationPath" label="Escalation path" defaultValue={v?.escalationPath} />
    </>
  );
}

function ServiceCard({ s, ctx }: { s: LenderService; ctx: ViewContext }) {
  const current = s.versions[0];
  const live = s.versions.find((v) => v.status === 'active' || v.status === 'suspended');
  if (!current) return null;
  const open = current.status === 'proposed' || current.status === 'under_discussion';
  return (
    <section className="card">
      <h3>
        {s.title} <span className="muted">({label(s.categoryKey)})</span>
      </h3>
      <p>
        Latest version {current.versionNo}: <strong>{label(current.status)}</strong>
        {live && live.id !== current.id
          ? ` — version ${live.versionNo} is ${label(live.status)}`
          : ''}
      </p>
      <Dl
        rows={[
          ['Requested scope', current.requestedScope],
          ['Udofin proposed scope', current.proposedScope],
          ['Final agreed scope', current.agreedScope ?? 'Not yet agreed'],
          [
            'Responsible / accountable',
            `${label(current.responsibleParty)} / ${label(current.accountableParty)}`,
          ],
          ['Shared allocation', current.sharedAllocation],
          [
            'Data exchanged / purpose',
            `${current.dataExchanged ?? '—'} / ${current.permittedPurpose ?? '—'}`,
          ],
          ['System of record', label(current.systemOfRecord)],
          ['Service levels', current.slaSummary],
          [
            'Acknowledged by lender / Udofin',
            `${stamp(current.lenderAgreedAt)} / ${stamp(current.udofinAgreedAt)}`,
          ],
        ]}
      />
      {open && current.agreedScope ? (
        <OpForm
          op="service.agree"
          action={ctx.action}
          returnTo={ctx.returnTo}
          hidden={{ id: current.id }}
          submit="Agree to this scope"
        />
      ) : null}
      {current.status === 'agreed' && ctx.caps.approve ? (
        <OpForm
          op="service.activate"
          action={ctx.action}
          returnTo={ctx.returnTo}
          hidden={{ id: current.id }}
          submit="Activate (independent approver)"
        />
      ) : null}
      {(current.status === 'active' || current.status === 'suspended') && ctx.caps.approve ? (
        <OpForm
          op="service.state"
          action={ctx.action}
          returnTo={ctx.returnTo}
          hidden={{ id: current.id }}
          submit="Change state"
          secondary
          inline
        >
          <SelectField
            name="to"
            label="New state"
            options={options(
              current.status === 'active' ? ['suspended', 'terminated'] : ['active', 'terminated'],
            )}
          />
          <TextField name="note" label="Reason" required />
        </OpForm>
      ) : null}
      {ctx.caps.submit || ctx.caps.manage ? (
        <details>
          <summary>
            {open ? 'Edit this version' : 'Propose a change (starts a new version)'}
          </summary>
          <OpForm
            op="service.revise"
            action={ctx.action}
            returnTo={ctx.returnTo}
            hidden={{ id: s.id }}
            submit="Save"
          >
            <ServiceFields v={current} ctx={ctx} />
          </OpForm>
        </details>
      ) : null}
      {s.versions.length > 1 ? (
        <details>
          <summary>Version history ({s.versions.length})</summary>
          <ul>
            {s.versions.map((v) => (
              <li key={v.id}>
                Version {v.versionNo}: {label(v.status)} (created {date(v.createdAt)})
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

export function ServicesTab({
  data,
  lenderId,
  ctx,
}: {
  data: TabData;
  lenderId: string;
  ctx: ViewContext;
}) {
  const categories = data.serviceCategories?.ok
    ? data.serviceCategories.data.items.filter((c) => c.active)
    : [];
  return (
    <Loadable result={data.services} title="services">
      {(s) => (
        <>
          <p role="note" className="muted">
            Each service has its own scope. Requested, proposed and agreed scope are different
            things: nothing is agreed until both sides agree, and nothing is active until an
            independent approver activates it. Changing a live service creates a new version.
          </p>
          {s.items.length === 0 ? (
            <EmptyState title="No services yet" detail="Propose the first service below." />
          ) : null}
          {s.items.map((svc) => (
            <ServiceCard key={svc.id} s={svc} ctx={ctx} />
          ))}
          {ctx.caps.submit || ctx.caps.manage ? (
            <section className="card">
              <h2>Propose a service</h2>
              <OpForm
                op="service.create"
                action={ctx.action}
                returnTo={ctx.returnTo}
                hidden={{ lenderId }}
                submit="Propose service"
              >
                <SelectField
                  name="categoryKey"
                  label="Category"
                  required
                  options={categories.map((c) => ({ value: c.key, label: c.label }))}
                />
                <TextField name="title" label="Title" required />
                <ServiceFields ctx={ctx} />
              </OpForm>
            </section>
          ) : null}
        </>
      )}
    </Loadable>
  );
}

// ---------------------------------------------------------------------------------------------
function RequirementActions({
  r,
  documents,
  ctx,
}: {
  r: Requirement;
  documents: readonly DocumentRecord[];
  ctx: ViewContext;
}) {
  const lender = ctx.caps.submit && !ctx.caps.manage;
  const move = (to: string, text: string, extra?: ReactNode, secondary?: boolean) => (
    <OpForm
      key={to}
      op="requirement.status"
      action={ctx.action}
      returnTo={ctx.returnTo}
      hidden={{ id: r.id, to }}
      submit={text}
      secondary={secondary}
      inline
    >
      {extra}
    </OpForm>
  );
  const evidence = (
    <SelectField
      name="evidenceDocumentId"
      label="Evidence"
      blank="No evidence"
      options={DocumentOptions(documents)}
    />
  );
  const note = <TextField name="note" label="Reason" required />;
  const items: ReactNode[] = [];
  if ((lender || ctx.caps.submit) && ['requested', 'rejected', 'expired'].includes(r.status))
    items.push(move('in_progress', 'Start'));
  if ((lender || ctx.caps.submit) && ['requested', 'in_progress'].includes(r.status))
    items.push(move('submitted', 'Submit', evidence));
  if (ctx.caps.manage && r.status === 'not_requested')
    items.push(move('requested', 'Request from lender'));
  if (ctx.caps.manage && r.status === 'submitted') items.push(move('under_review', 'Start review'));
  if (ctx.caps.approve && r.status === 'under_review') {
    items.push(move('accepted', 'Accept'));
    items.push(move('rejected', 'Reject', note, true));
  }
  if (ctx.caps.approve && !['accepted', 'waived', 'not_applicable'].includes(r.status)) {
    items.push(move('waived', 'Waive', note, true));
    items.push(move('not_applicable', 'Not applicable', note, true));
  }
  return <>{items}</>;
}

export function RequirementsTab({
  data,
  lenderId,
  ctx,
}: {
  data: TabData;
  lenderId: string;
  ctx: ViewContext;
}) {
  const documents = data.documents?.ok ? data.documents.data.items : [];
  const services = data.services?.ok ? data.services.data.items : [];
  return (
    <Loadable result={data.requirements} title="requirements">
      {(rq) => {
        const open = rq.items.filter(
          (r) => r.mandatory && !['accepted', 'waived', 'not_applicable'].includes(r.status),
        );
        return (
          <>
            <p role="status">
              {rq.items.length === 0
                ? 'No requirements generated yet.'
                : `${String(open.length)} mandatory requirement(s) still open.`}
            </p>
            {ctx.caps.manage ? (
              <OpForm
                op="requirement.generate"
                action={ctx.action}
                returnTo={ctx.returnTo}
                hidden={{ lenderId }}
                submit="Generate checklist from templates"
                secondary
              />
            ) : null}
            {rq.items.length > 0 ? (
              <table>
                <caption className="sr-only">Requirements the lender provides</caption>
                <thead>
                  <tr>
                    <th scope="col">Requirement</th>
                    <th scope="col">Status</th>
                    <th scope="col">Mandatory</th>
                    <th scope="col">Depends on</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rq.items.map((r) => (
                    <tr key={r.id}>
                      <th scope="row">
                        {r.title}
                        {r.description ? <div className="muted">{r.description}</div> : null}
                        {r.comments ? <div>Note: {r.comments}</div> : null}
                      </th>
                      <td>{label(r.status)}</td>
                      <td>{r.mandatory ? 'Yes' : 'No'}</td>
                      <td>
                        {r.dependsOn.length === 0
                          ? '—'
                          : r.dependsOn
                              .map((d) => rq.items.find((x) => x.id === d)?.title ?? 'Unknown')
                              .join(', ')}
                      </td>
                      <td>
                        <RequirementActions r={r} documents={documents} ctx={ctx} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {ctx.caps.manage ? (
              <>
                <section className="card">
                  <h2>Add a requirement</h2>
                  <OpForm
                    op="requirement.create"
                    action={ctx.action}
                    returnTo={ctx.returnTo}
                    hidden={{ lenderId }}
                    submit="Add requirement"
                  >
                    <TextField name="title" label="Title" required />
                    <AreaField name="description" label="What is needed" />
                    <SelectField
                      name="serviceId"
                      label="For service (optional)"
                      blank="Whole lender"
                      options={services.map((s) => ({ value: s.id, label: s.title }))}
                    />
                    <TextField name="dueOn" label="Due on" type="date" />
                    <SelectField
                      name="mandatory"
                      label="Mandatory"
                      options={[
                        { value: 'true', label: 'Yes' },
                        { value: 'false', label: 'No' },
                      ]}
                      defaultValue="true"
                    />
                    <SelectField
                      name="evidenceRequired"
                      label="Evidence required"
                      options={[
                        { value: 'false', label: 'No' },
                        { value: 'true', label: 'Yes' },
                      ]}
                      defaultValue="false"
                    />
                  </OpForm>
                </section>
                {rq.items.length > 1 ? (
                  <section className="card">
                    <h2>Record a dependency</h2>
                    <OpForm
                      op="requirement.dependency"
                      action={ctx.action}
                      returnTo={ctx.returnTo}
                      submit="Add dependency"
                    >
                      <SelectField
                        name="id"
                        label="This requirement"
                        required
                        options={rq.items.map((r) => ({ value: r.id, label: r.title }))}
                      />
                      <SelectField
                        name="dependsOnId"
                        label="cannot be accepted before this one is closed"
                        required
                        options={rq.items.map((r) => ({ value: r.id, label: r.title }))}
                      />
                    </OpForm>
                  </section>
                ) : null}
              </>
            ) : null}
          </>
        );
      }}
    </Loadable>
  );
}

// ---------------------------------------------------------------------------------------------
export function IntegrationsTab({
  data,
  lenderId,
  ctx,
}: {
  data: TabData;
  lenderId: string;
  ctx: ViewContext;
}) {
  const documents = data.documents?.ok ? data.documents.data.items : [];
  return (
    <Loadable result={data.integrations} title="integrations">
      {(i) => (
        <>
          <p role="note" className="muted">
            Integrations are tested before production. Where an integration is not required, a
            manual process can stand in only through a documented exception approved by a second
            person. No credentials are stored here.
          </p>
          {i.items.length === 0 ? (
            <EmptyState title="No integrations recorded" />
          ) : (
            <table>
              <caption className="sr-only">Integrations</caption>
              <thead>
                <tr>
                  <th scope="col">Integration</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {i.items.map((x) => (
                  <tr key={x.id}>
                    <th scope="row">
                      {x.name}
                      {x.purpose ? <div className="muted">{x.purpose}</div> : null}
                      {x.manualExceptionReason ? (
                        <div>Exception: {x.manualExceptionReason}</div>
                      ) : null}
                    </th>
                    <td>{label(x.kind)}</td>
                    <td>
                      {label(x.status)}
                      {x.testedOn ? ` (${date(x.testedOn)})` : ''}
                    </td>
                    <td>
                      {ctx.caps.manage && x.status !== 'manual_exception' ? (
                        <>
                          <OpForm
                            op="integration.result"
                            action={ctx.action}
                            returnTo={ctx.returnTo}
                            hidden={{ id: x.id }}
                            submit="Record result"
                            inline
                          >
                            <SelectField
                              name="status"
                              label="Result"
                              options={options(['in_progress', 'tested', 'failed'])}
                            />
                            <SelectField
                              name="evidenceDocumentId"
                              label="Test evidence"
                              blank="None"
                              options={DocumentOptions(documents)}
                            />
                          </OpForm>
                          <OpForm
                            op="integration.exception"
                            action={ctx.action}
                            returnTo={ctx.returnTo}
                            hidden={{ id: x.id }}
                            submit="Request manual exception"
                            secondary
                            inline
                          >
                            <TextField
                              name="reason"
                              label="Why a manual process is acceptable"
                              required
                            />
                          </OpForm>
                        </>
                      ) : null}
                      {ctx.caps.approve && x.manualExceptionReason && !x.exceptionApproved ? (
                        <>
                          <OpForm
                            op="integration.exceptionDecide"
                            action={ctx.action}
                            returnTo={ctx.returnTo}
                            hidden={{ id: x.id, approve: 'true' }}
                            submit="Approve exception"
                            inline
                          />
                          <OpForm
                            op="integration.exceptionDecide"
                            action={ctx.action}
                            returnTo={ctx.returnTo}
                            hidden={{ id: x.id, approve: 'false' }}
                            submit="Decline"
                            secondary
                            inline
                          />
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {ctx.caps.submit || ctx.caps.manage ? (
            <section className="card">
              <h2>Record an integration</h2>
              <OpForm
                op="integration.create"
                action={ctx.action}
                returnTo={ctx.returnTo}
                hidden={{ lenderId }}
                submit="Record integration"
              >
                <SelectField name="kind" label="Kind" options={options(INTEGRATION_KINDS)} />
                <TextField name="name" label="Name" required />
                <AreaField name="purpose" label="Purpose" />
                <AreaField name="notes" label="Notes (never credentials or keys)" />
              </OpForm>
            </section>
          ) : null}
        </>
      )}
    </Loadable>
  );
}

export function ContractsTab({
  data,
  lenderId,
  ctx,
}: {
  data: TabData;
  lenderId: string;
  ctx: ViewContext;
}) {
  const documents = data.documents?.ok ? data.documents.data.items : [];
  return (
    <Loadable result={data.contracts} title="contracts">
      {(c) => (
        <>
          <p role="note" className="muted">
            Recording or verifying a contract does not approve services, products or commercial
            terms.
          </p>
          {c.items.length === 0 ? (
            <EmptyState title="No contracts recorded" />
          ) : (
            <table>
              <caption className="sr-only">Contracts</caption>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Type</th>
                  <th scope="col">Status</th>
                  <th scope="col">Verified</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {c.items.map((x) => (
                  <tr key={x.id}>
                    <th scope="row">{x.reference}</th>
                    <td>{label(x.contractType)}</td>
                    <td>
                      {label(x.status)} {x.executedOn ? `(${date(x.executedOn)})` : ''}
                    </td>
                    <td>{x.verified ? `Yes (${date(x.verifiedAt)})` : 'No'}</td>
                    <td>
                      {ctx.caps.approve && x.status === 'executed' && !x.verified ? (
                        <>
                          <OpForm
                            op="contract.decide"
                            action={ctx.action}
                            returnTo={ctx.returnTo}
                            hidden={{ id: x.id, approve: 'true' }}
                            submit="Verify"
                            inline
                          />
                          <OpForm
                            op="contract.decide"
                            action={ctx.action}
                            returnTo={ctx.returnTo}
                            hidden={{ id: x.id, approve: 'false' }}
                            submit="Send back"
                            secondary
                            inline
                          >
                            <TextField name="note" label="Reason" required />
                          </OpForm>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {ctx.caps.manage ? (
            <section className="card">
              <h2>Record a contract</h2>
              <OpForm
                op="contract.record"
                action={ctx.action}
                returnTo={ctx.returnTo}
                hidden={{ lenderId }}
                submit="Record contract"
              >
                <SelectField name="contractType" label="Type" options={options(CONTRACT_TYPES)} />
                <TextField name="reference" label="Reference" required />
                <SelectField
                  name="status"
                  label="Status"
                  options={[
                    { value: 'draft', label: 'Draft' },
                    { value: 'executed', label: 'Executed (needs date and signed copy)' },
                  ]}
                />
                <TextField name="executedOn" label="Executed on" type="date" />
                <TextField name="effectiveFrom" label="Effective from" type="date" />
                <TextField name="effectiveUntil" label="Effective until" type="date" />
                <SelectField
                  name="documentId"
                  label="Signed copy"
                  blank="None"
                  options={DocumentOptions(documents)}
                />
                <AreaField name="note" label="Note" />
              </OpForm>
            </section>
          ) : null}
        </>
      )}
    </Loadable>
  );
}

export function DocumentsTab({
  data,
  lenderId,
  ctx,
  downloadBase,
}: {
  data: TabData;
  lenderId: string;
  ctx: ViewContext;
  downloadBase: string;
}) {
  return (
    <Loadable result={data.documents} title="documents">
      {(d) => (
        <>
          <p role="note" className="muted">
            Documents are stored privately and encrypted. Every retrieval is logged. Upload PDF, PNG
            or JPEG files up to 8 MiB. Do not upload borrower data.
          </p>
          {d.items.length === 0 ? (
            <EmptyState title="No documents" />
          ) : (
            <table>
              <caption className="sr-only">Documents</caption>
              <thead>
                <tr>
                  <th scope="col">Document</th>
                  <th scope="col">Purpose</th>
                  <th scope="col">Uploaded</th>
                  <th scope="col">Size</th>
                  <th scope="col">Checksum</th>
                  <th scope="col">
                    <span className="sr-only">Download</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((x) => (
                  <tr key={x.id}>
                    <th scope="row">{x.label}</th>
                    <td>{label(x.purpose)}</td>
                    <td>{stamp(x.uploadedAt)}</td>
                    <td>{String(Math.ceil(x.sizeBytes / 1024))} KiB</td>
                    <td>
                      <code>{x.sha256.slice(0, 12)}…</code>
                    </td>
                    <td>
                      <a href={`${downloadBase}/${x.id}`}>Download</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {ctx.caps.submit || ctx.caps.manage ? (
            <section className="card">
              <h2>Upload a document</h2>
              <OpForm
                op="document.upload"
                action={ctx.action}
                returnTo={ctx.returnTo}
                hidden={{ lenderId }}
                submit="Upload"
              >
                <SelectField name="purpose" label="Purpose" options={options(DOCUMENT_PURPOSES)} />
                <TextField name="label" label="Label (no personal data)" required />
                <div className="field">
                  <label htmlFor="upload-file">File</label>
                  <input
                    id="upload-file"
                    type="file"
                    name="file"
                    accept="application/pdf,image/png,image/jpeg"
                    required
                  />
                </div>
              </OpForm>
            </section>
          ) : null}
        </>
      )}
    </Loadable>
  );
}

export function GatesTab({
  data,
  lenderId,
  ctx,
}: {
  data: TabData;
  lenderId: string;
  ctx: ViewContext;
}) {
  return (
    <Loadable result={data.overview} title="the lender">
      {(o) => (
        <>
          {o.gate ? (
            <StageTracker stage={o.gate.stage} />
          ) : (
            <EmptyState title="No gate yet" detail="Create the institution profile first." />
          )}
          <Loadable result={data.conditions} title="gate conditions">
            {(c) => (
              <section className="card">
                <h2>Conditions for: {label(c.targetStage)}</h2>
                <table>
                  <caption className="sr-only">Gate conditions</caption>
                  <thead>
                    <tr>
                      <th scope="col">Condition</th>
                      <th scope="col">Met</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.items.map((i) => (
                      <tr key={i.key}>
                        <th scope="row">{i.detail}</th>
                        <td>{i.satisfied ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {c.items.length === 0 ? (
                  <p className="muted">No conditions for this step.</p>
                ) : null}
                {ctx.caps.manage ? (
                  <OpForm
                    op="gate.request"
                    action={ctx.action}
                    returnTo={ctx.returnTo}
                    hidden={{ lenderId, targetStage: c.targetStage }}
                    submit={`Request: ${label(c.targetStage)}`}
                  >
                    <TextField name="note" label="Note for the approver" />
                  </OpForm>
                ) : null}
              </section>
            )}
          </Loadable>
          <Loadable result={data.gateRequests} title="gate requests">
            {(g) => (
              <section className="card">
                <h2>Gate requests</h2>
                {g.items.length === 0 ? (
                  <p className="muted">None yet.</p>
                ) : (
                  <table>
                    <caption className="sr-only">Gate requests, newest first</caption>
                    <thead>
                      <tr>
                        <th scope="col">Requested</th>
                        <th scope="col">Step</th>
                        <th scope="col">Status</th>
                        <th scope="col">Decided</th>
                        <th scope="col">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.items.map((r) => (
                        <tr key={r.id}>
                          <td>{stamp(r.requestedAt)}</td>
                          <td>
                            {label(r.fromStage)} → {label(r.targetStage)}
                          </td>
                          <td>{label(r.status)}</td>
                          <td>
                            {stamp(r.decidedAt)}
                            {r.decisionNote ? ` — ${r.decisionNote}` : ''}
                          </td>
                          <td>
                            {r.status === 'pending' && ctx.caps.approve ? (
                              <>
                                <OpForm
                                  op="gate.decide"
                                  action={ctx.action}
                                  returnTo={ctx.returnTo}
                                  hidden={{ id: r.id, approve: 'true' }}
                                  submit="Approve"
                                  inline
                                />
                                <OpForm
                                  op="gate.decide"
                                  action={ctx.action}
                                  returnTo={ctx.returnTo}
                                  hidden={{ id: r.id, approve: 'false' }}
                                  submit="Reject"
                                  secondary
                                  inline
                                >
                                  <TextField name="note" label="Reason" required />
                                </OpForm>
                              </>
                            ) : null}
                            {r.status === 'pending' && ctx.caps.manage ? (
                              <OpForm
                                op="gate.cancel"
                                action={ctx.action}
                                returnTo={ctx.returnTo}
                                hidden={{ id: r.id }}
                                submit="Withdraw"
                                secondary
                                inline
                              />
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            )}
          </Loadable>
        </>
      )}
    </Loadable>
  );
}

export function CategorySignoff({
  categories,
  ctx,
}: {
  categories: Loaded<typeof InstitutionCategoryList>;
  ctx: ViewContext;
}) {
  return (
    <Loadable result={categories} title="institution categories">
      {(c) => (
        <table>
          <caption className="sr-only">Institution categories and compliance sign-off</caption>
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Regulatory basis</th>
              <th scope="col">Can be activated</th>
              <th scope="col">Sign-off</th>
            </tr>
          </thead>
          <tbody>
            {c.items.map((x) => (
              <tr key={x.key}>
                <th scope="row">
                  {x.label}
                  <div className="muted">{x.regimeNote}</div>
                </th>
                <td>{label(x.regimeStatus)}</td>
                <td>
                  {x.activationAllowed ? 'Yes' : 'No'}
                  {x.signoffSourceRef ? ` — ${x.signoffSourceRef}` : ''}
                </td>
                <td>
                  {ctx.caps.compliance && !x.activationAllowed ? (
                    <OpForm
                      op="category.signoff"
                      action={ctx.action}
                      returnTo={ctx.returnTo}
                      hidden={{ categoryKey: x.key }}
                      submit="Sign off"
                      inline
                    >
                      <TextField
                        name="sourceRef"
                        label="Primary source reviewed (title and date)"
                        required
                      />
                    </OpForm>
                  ) : null}
                  {ctx.caps.compliance &&
                  x.activationAllowed &&
                  x.regimeStatus !== 'confirmed_primary' ? (
                    <OpForm
                      op="category.revoke"
                      action={ctx.action}
                      returnTo={ctx.returnTo}
                      hidden={{ categoryKey: x.key }}
                      submit="Withdraw sign-off"
                      secondary
                      inline
                    />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Loadable>
  );
}

export type { ServiceVersion };

/** The whole lender page body: header, stage, section tabs and the selected section. */
export function LenderBody({
  tab,
  data,
  lenderId,
  ctx,
  base,
  downloadBase,
  done,
  error,
}: {
  tab: Tab;
  data: TabData;
  lenderId: string;
  ctx: ViewContext;
  base: string;
  downloadBase: string;
  done?: boolean;
  error?: string | undefined;
}) {
  return (
    <>
      <Loadable result={data.overview} title="the lender">
        {(o) => (
          <>
            <h1>{o.summary.displayName}</h1>
            <p className="muted">
              {o.summary.legalName} · {o.summary.categoryLabel ?? 'No institution profile yet'} ·
              organisation status: {label(o.summary.organizationStatus)}
            </p>
            {o.gate && tab !== 'gates' ? (
              <p>
                Activation stage: <strong>{label(o.gate.stage)}</strong>{' '}
                <a href={`${base}/${lenderId}?tab=gates`}>See gates</a>
              </p>
            ) : null}
          </>
        )}
      </Loadable>
      <TabNav base={base} lenderId={lenderId} current={tab} />
      <Notice done={done} error={error} />
      {tab === 'profile' ? <ProfileTab data={data} lenderId={lenderId} ctx={ctx} /> : null}
      {tab === 'accounting' ? <AccountingTab data={data} lenderId={lenderId} ctx={ctx} /> : null}
      {tab === 'services' ? <ServicesTab data={data} lenderId={lenderId} ctx={ctx} /> : null}
      {tab === 'requirements' ? (
        <RequirementsTab data={data} lenderId={lenderId} ctx={ctx} />
      ) : null}
      {tab === 'integrations' ? (
        <IntegrationsTab data={data} lenderId={lenderId} ctx={ctx} />
      ) : null}
      {tab === 'contracts' ? <ContractsTab data={data} lenderId={lenderId} ctx={ctx} /> : null}
      {tab === 'documents' ? (
        <DocumentsTab data={data} lenderId={lenderId} ctx={ctx} downloadBase={downloadBase} />
      ) : null}
      {tab === 'gates' ? <GatesTab data={data} lenderId={lenderId} ctx={ctx} /> : null}
    </>
  );
}

/** Optional, controlled waiver of the verified accounting record (owner decision D-33). */
function WaiverSection({
  data,
  lenderId,
  ctx,
}: {
  data: TabData;
  lenderId: string;
  ctx: ViewContext;
}) {
  const enabled = data.settings?.ok
    ? data.settings.data.items.find((i) => i.key === 'accounting_waiver_allowed')?.value === true
    : false;
  const waivers = data.waivers?.ok ? data.waivers.data.items : [];
  if (!ctx.caps.read || ctx.portal !== 'ops') return null;
  return (
    <section className="card">
      <h2>Waiver of the verified accounting record</h2>
      <p className="muted">
        By default production readiness needs a verified record. The compliance officer can allow
        waivers; each waiver needs a written reason, a second person to approve it, and stops
        counting if the option is switched off.
      </p>
      <p>
        Option currently: <strong>{enabled ? 'allowed' : 'not allowed'}</strong>
      </p>
      {ctx.caps.compliance ? (
        <OpForm
          op="setting.set"
          action={ctx.action}
          returnTo={ctx.returnTo}
          hidden={{ key: 'accounting_waiver_allowed', value: enabled ? 'false' : 'true' }}
          submit={enabled ? 'Switch off' : 'Switch on'}
          secondary
        >
          <TextField name="reason" label="Reason for the change (20+ characters)" required />
        </OpForm>
      ) : null}
      {waivers.length > 0 ? (
        <ul className="plain">
          {waivers.map((w) => (
            <li key={w.id}>
              {label(w.status)} — {w.reason}
              {ctx.caps.approve && w.status === 'pending' ? (
                <>
                  <OpForm
                    op="waiver.decide"
                    action={ctx.action}
                    returnTo={ctx.returnTo}
                    hidden={{ id: w.id, approve: 'true' }}
                    submit="Approve"
                    inline
                  />
                  <OpForm
                    op="waiver.decide"
                    action={ctx.action}
                    returnTo={ctx.returnTo}
                    hidden={{ id: w.id, approve: 'false' }}
                    submit="Reject"
                    secondary
                    inline
                  />
                </>
              ) : null}
              {ctx.caps.approve && w.status === 'approved' ? (
                <OpForm
                  op="waiver.decide"
                  action={ctx.action}
                  returnTo={ctx.returnTo}
                  hidden={{ id: w.id, approve: 'false', revoke: 'true' }}
                  submit="Revoke"
                  secondary
                  inline
                >
                  <TextField name="note" label="Reason" required />
                </OpForm>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {ctx.caps.manage &&
      enabled &&
      !waivers.some((w) => w.status === 'pending' || w.status === 'approved') ? (
        <OpForm
          op="waiver.request"
          action={ctx.action}
          returnTo={ctx.returnTo}
          hidden={{ lenderId }}
          submit="Request a waiver"
        >
          <AreaField
            name="reason"
            label="Why the verified record is not required for go-live (30+ characters)"
            required
          />
        </OpForm>
      ) : null}
    </section>
  );
}
