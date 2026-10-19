import {
  ELIGIBILITY_FIELDS,
  ELIGIBILITY_OPERATORS,
  FEE_KINDS,
  FEE_TIMINGS,
  INSTALLMENT_TYPES,
  REPAYMENT_FREQUENCIES,
  REPAYMENT_METHODS,
  type Product,
  type ProductConfigV1,
  type ProductVersion,
} from '@udofin/contracts';
import { AreaField, OpForm, SelectField, TextField } from '../onboarding/forms.js';
import { label } from '../onboarding/labels.js';
import { EmptyState, ErrorState } from '../states.js';
import { Notice, type ViewContext, formatRupees } from '../onboarding/views.js';

const opts = (values: readonly string[]) => values.map((v) => ({ value: v, label: label(v) }));
const ROWS = 4;

function Check({ name, text, on }: { name: string; text: string; on?: boolean | undefined }) {
  return (
    <label>
      <input type="checkbox" name={name} defaultChecked={on ?? false} /> {text}
    </label>
  );
}

/** Every product setting as form fields; prefilled from an earlier version when one is given. */
function VersionFields({ v }: { v?: ProductVersion | undefined }) {
  const c: Partial<ProductConfigV1> = v?.config ?? {};
  const t = v?.terms;
  const fees = c.fees ?? [];
  const rules = c.eligibility?.rules ?? [];
  const docs = c.documents ?? [];
  const attrs = Object.entries(c.attributes ?? {});
  return (
    <>
      <fieldset>
        <legend>Terms (amounts in paise, rates in basis points)</legend>
        <TextField
          name="minAmountMinor"
          label="Minimum amount (paise)"
          required
          defaultValue={t ? String(t.minAmountMinor) : undefined}
        />
        <TextField
          name="maxAmountMinor"
          label="Maximum amount (paise)"
          required
          defaultValue={t ? String(t.maxAmountMinor) : undefined}
        />
        <TextField
          name="minTenureDays"
          label="Minimum tenure (days)"
          required
          defaultValue={t ? String(t.minTenureDays) : undefined}
        />
        <TextField
          name="maxTenureDays"
          label="Maximum tenure (days)"
          required
          defaultValue={t ? String(t.maxTenureDays) : undefined}
        />
        <SelectField
          name="rateType"
          label="Rate type"
          options={opts(['fixed', 'floating'])}
          defaultValue={t?.rateType ?? 'fixed'}
        />
        <TextField
          name="minAnnualRateBps"
          label="Minimum annual rate (bps)"
          required
          defaultValue={t ? String(t.minAnnualRateBps) : undefined}
        />
        <TextField
          name="maxAnnualRateBps"
          label="Maximum annual rate (bps)"
          required
          defaultValue={t ? String(t.maxAnnualRateBps) : undefined}
        />
      </fieldset>
      <fieldset>
        <legend>Display</legend>
        <TextField
          name="marketingName"
          label="Name shown to borrowers"
          defaultValue={c.display?.marketingName}
        />
        <AreaField
          name="shortDescription"
          label="Short description (factual, no promises)"
          defaultValue={c.display?.shortDescription}
        />
      </fieldset>
      <fieldset>
        <legend>Fees (up to {ROWS})</legend>
        {Array.from({ length: ROWS }, (_, i) => {
          const f = fees[i];
          return (
            <div key={i} className="row">
              <TextField
                name={`fee_${String(i)}_code`}
                label={`Fee ${String(i + 1)} code (a-z, 0-9, _)`}
                defaultValue={f?.code}
              />
              <TextField name={`fee_${String(i)}_label`} label="Label" defaultValue={f?.label} />
              <SelectField
                name={`fee_${String(i)}_kind`}
                label="Kind"
                options={opts(FEE_KINDS)}
                defaultValue={f?.kind ?? 'flat'}
              />
              <TextField
                name={`fee_${String(i)}_amountMinor`}
                label="Amount (paise, flat)"
                defaultValue={f?.amountMinor === undefined ? undefined : String(f.amountMinor)}
              />
              <TextField
                name={`fee_${String(i)}_rateBps`}
                label="Rate (bps, percentage)"
                defaultValue={f?.rateBps === undefined ? undefined : String(f.rateBps)}
              />
              <SelectField
                name={`fee_${String(i)}_timing`}
                label="Collected"
                options={opts(FEE_TIMINGS)}
                defaultValue={f?.timing ?? 'at_disbursement'}
              />
              <Check
                name={`fee_${String(i)}_taxIncluded`}
                text="Tax included"
                on={f?.taxIncluded}
              />
              <Check name={`fee_${String(i)}_refundable`} text="Refundable" on={f?.refundable} />
            </div>
          );
        })}
      </fieldset>
      <fieldset>
        <legend>Eligibility rules (up to {ROWS})</legend>
        <SelectField
          name="elig_match"
          label="Borrower must meet"
          options={[
            { value: 'all', label: 'All rules' },
            { value: 'any', label: 'Any rule' },
          ]}
          defaultValue={c.eligibility?.match ?? 'all'}
        />
        {Array.from({ length: ROWS }, (_, i) => {
          const r = rules[i];
          return (
            <div key={i} className="row">
              <SelectField
                name={`elig_${String(i)}_field`}
                label={`Rule ${String(i + 1)} field`}
                blank="(none)"
                options={opts(ELIGIBILITY_FIELDS)}
                defaultValue={r?.field}
              />
              <SelectField
                name={`elig_${String(i)}_operator`}
                label="Operator"
                options={opts(ELIGIBILITY_OPERATORS)}
                defaultValue={r?.operator ?? 'gte'}
              />
              <TextField
                name={`elig_${String(i)}_value`}
                label="Value (comma-separated for in / between)"
                defaultValue={
                  r ? (Array.isArray(r.value) ? r.value.join(',') : String(r.value)) : undefined
                }
              />
            </div>
          );
        })}
      </fieldset>
      <fieldset>
        <legend>Repayment</legend>
        <div>
          Frequencies:{' '}
          {REPAYMENT_FREQUENCIES.map((f) => (
            <label key={f}>
              <input
                type="checkbox"
                name="repay_frequencies"
                value={f}
                defaultChecked={c.repayment?.frequencies.includes(f) ?? false}
              />{' '}
              {label(f)}{' '}
            </label>
          ))}
        </div>
        <div>
          Methods:{' '}
          {REPAYMENT_METHODS.map((m) => (
            <label key={m}>
              <input
                type="checkbox"
                name="repay_methods"
                value={m}
                defaultChecked={c.repayment?.methods.includes(m) ?? false}
              />{' '}
              {label(m)}{' '}
            </label>
          ))}
        </div>
        <SelectField
          name="installmentType"
          label="Instalment type"
          options={opts(INSTALLMENT_TYPES)}
          defaultValue={c.repayment?.installmentType ?? 'equated'}
        />
        <TextField
          name="repay_grace"
          label="Grace period (days)"
          defaultValue={String(c.repayment?.gracePeriodDays ?? 0)}
        />
        <TextField
          name="repay_moratorium"
          label="Moratorium (days)"
          defaultValue={String(c.repayment?.moratoriumDays ?? 0)}
        />
      </fieldset>
      <fieldset>
        <legend>Prepayment and penal charges</legend>
        <input type="hidden" name="prepay_present" value="1" />
        <Check name="prepay_allowed" text="Prepayment allowed" on={c.prepayment?.allowed ?? true} />
        <Check
          name="prepay_part"
          text="Part prepayment allowed"
          on={c.prepayment?.partPrepaymentAllowed ?? true}
        />
        <TextField
          name="prepay_lockin"
          label="Lock-in (days)"
          defaultValue={String(c.prepayment?.lockInDays ?? 0)}
        />
        <TextField
          name="prepay_charge"
          label="Prepayment charge (plain-language summary)"
          defaultValue={c.prepayment?.chargeSummary}
        />
        <SelectField
          name="penal_kind"
          label="Penal charges"
          blank="None"
          options={[
            { value: 'flat', label: 'Flat' },
            { value: 'percent_of_overdue_amount', label: 'Percent of overdue amount' },
          ]}
          defaultValue={c.penalCharges?.kind}
        />
        <TextField
          name="penal_amount"
          label="Flat amount (paise)"
          defaultValue={
            c.penalCharges?.amountMinor === undefined
              ? undefined
              : String(c.penalCharges.amountMinor)
          }
        />
        <TextField
          name="penal_rate"
          label="Rate (bps)"
          defaultValue={
            c.penalCharges?.rateBps === undefined ? undefined : String(c.penalCharges.rateBps)
          }
        />
        <TextField
          name="penal_grace"
          label="Grace (days)"
          defaultValue={String(c.penalCharges?.gracePeriodDays ?? 0)}
        />
        <TextField
          name="penal_summary"
          label="Plain-language summary shown to borrowers"
          defaultValue={c.penalCharges?.summary}
        />
      </fieldset>
      <fieldset>
        <legend>Documents the borrower provides (up to {ROWS})</legend>
        {Array.from({ length: ROWS }, (_, i) => {
          const d = docs[i];
          return (
            <div key={i} className="row">
              <TextField
                name={`doc_${String(i)}_code`}
                label={`Document ${String(i + 1)} code`}
                defaultValue={d?.code}
              />
              <TextField name={`doc_${String(i)}_label`} label="Label" defaultValue={d?.label} />
              <SelectField
                name={`doc_${String(i)}_mime`}
                label="Accepted type"
                options={[
                  { value: 'application/pdf', label: 'PDF' },
                  { value: 'image/png', label: 'PNG' },
                  { value: 'image/jpeg', label: 'JPEG' },
                ]}
                defaultValue={d?.acceptedMimeTypes[0] ?? 'application/pdf'}
              />
              <Check name={`doc_${String(i)}_mandatory`} text="Mandatory" on={d?.mandatory} />
            </div>
          );
        })}
      </fieldset>
      <fieldset>
        <legend>Your own attributes (never personal data or secrets)</legend>
        {Array.from({ length: ROWS }, (_, i) => (
          <div key={i} className="row">
            <TextField
              name={`attr_${String(i)}_key`}
              label={`Attribute ${String(i + 1)} key`}
              defaultValue={attrs[i]?.[0]}
            />
            <TextField
              name={`attr_${String(i)}_value`}
              label="Value"
              defaultValue={attrs[i] ? String(attrs[i][1]) : undefined}
            />
          </div>
        ))}
      </fieldset>
      <details>
        <summary>Advanced: paste the whole configuration as JSON</summary>
        <AreaField
          name="advancedJson"
          label="Configuration JSON (replaces everything above except the terms)"
          hint="Use for anything the fields above do not cover, within the schema shown by the configuration catalogue."
        />
      </details>
    </>
  );
}

function VersionSummary({ v }: { v: ProductVersion }) {
  const c = v.config;
  return (
    <ul className="plain">
      <li>
        Amount ₹{formatRupees(String(v.terms.minAmountMinor))} – ₹
        {formatRupees(String(v.terms.maxAmountMinor))}; tenure {v.terms.minTenureDays}–
        {v.terms.maxTenureDays} days; {label(v.terms.rateType)} rate{' '}
        {(v.terms.minAnnualRateBps / 100).toFixed(2)}%–{(v.terms.maxAnnualRateBps / 100).toFixed(2)}
        % a year
      </li>
      <li>
        {c.fees.length} fee(s), {c.eligibility?.rules.length ?? 0} eligibility rule(s),{' '}
        {c.documents.length} document(s), {Object.keys(c.attributes).length} attribute(s)
      </li>
      {c.repayment ? (
        <li>
          Repayment: {c.repayment.frequencies.map(label).join(', ')} via{' '}
          {c.repayment.methods.map(label).join(', ')}
        </li>
      ) : null}
    </ul>
  );
}

function ProductCard({ p, ctx }: { p: Product; ctx: ViewContext }) {
  const latest = p.versions[0];
  const canConfigure = ctx.caps.productConfigure === true;
  const canApprove = ctx.caps.productApprove === true;
  return (
    <section className="card">
      <h2>
        {p.name}{' '}
        <span className="muted">
          ({p.code}, {label(p.categoryKey)})
        </span>
      </h2>
      <p>
        Product status: <strong>{label(p.status)}</strong>. A product reaches borrowers only when it
        is active, has an approved version and the lender itself is live.
      </p>
      {canApprove && p.status !== 'retired' ? (
        <OpForm
          op="product.status"
          action={ctx.action}
          returnTo={ctx.returnTo}
          hidden={{ id: p.id }}
          submit="Change status"
          secondary
          inline
        >
          <SelectField
            name="to"
            label="New status"
            options={opts(
              p.status === 'active'
                ? ['suspended', 'retired']
                : p.status === 'suspended'
                  ? ['active', 'retired']
                  : ['active', 'retired'],
            )}
          />
        </OpForm>
      ) : null}
      {p.versions.length === 0 ? <p className="muted">No versions yet.</p> : null}
      {p.versions.map((v) => (
        <div key={v.id} className="card">
          <h3>
            Version {v.version} — {label(v.status)}
          </h3>
          <VersionSummary v={v} />
          {v.status === 'draft' && canConfigure && v.draftedBy === ctx.userId ? (
            <>
              <OpForm
                op="product.version.submit"
                action={ctx.action}
                returnTo={ctx.returnTo}
                hidden={{ id: v.id }}
                submit="Send for approval"
              />
              <details>
                <summary>Edit this draft</summary>
                <OpForm
                  op="product.version.edit"
                  action={ctx.action}
                  returnTo={ctx.returnTo}
                  hidden={{ id: v.id }}
                  submit="Save draft"
                >
                  <VersionFields v={v} />
                </OpForm>
              </details>
            </>
          ) : null}
          {v.status === 'pending_approval' && canApprove && v.draftedBy !== ctx.userId ? (
            <>
              <OpForm
                op="product.version.decide"
                action={ctx.action}
                returnTo={ctx.returnTo}
                hidden={{ id: v.id, approve: 'true' }}
                submit="Approve"
              />
              <OpForm
                op="product.version.decide"
                action={ctx.action}
                returnTo={ctx.returnTo}
                hidden={{ id: v.id, approve: 'false' }}
                submit="Send back"
                secondary
              >
                <TextField name="note" label="Reason (at least 10 characters)" required />
              </OpForm>
            </>
          ) : null}
          {v.status === 'pending_approval' && v.draftedBy === ctx.userId ? (
            <p className="muted">Waiting for a different person to approve.</p>
          ) : null}
          {v.status === 'approved' && canApprove ? (
            <OpForm
              op="product.version.retire"
              action={ctx.action}
              returnTo={ctx.returnTo}
              hidden={{ id: v.id }}
              submit="Retire this version"
              secondary
            />
          ) : null}
        </div>
      ))}
      {canConfigure ? (
        <details>
          <summary>Draft a new version{latest ? ' (starts from the latest)' : ''}</summary>
          <OpForm
            op="product.version.create"
            action={ctx.action}
            returnTo={ctx.returnTo}
            hidden={{ id: p.id }}
            submit="Create draft version"
          >
            <VersionFields v={latest} />
          </OpForm>
        </details>
      ) : null}
    </section>
  );
}

export function ProductsPage({
  products,
  categories,
  lenderId,
  ctx,
  done,
  error,
}: {
  products: { ok: true; data: { items: Product[] } } | { ok: false; status: number };
  categories: readonly { key: string; label: string }[];
  lenderId: string | undefined;
  ctx: ViewContext;
  done?: boolean;
  error?: string | undefined;
}) {
  return (
    <>
      <h1>Products</h1>
      <p className="muted">
        You define your own products. Udofin stores and presents what you approve; it does not check
        terms against regulatory limits, so your own compliance review stays essential. Approved
        versions cannot be edited: change a product by drafting a new version.
      </p>
      <Notice done={done} error={error} />
      {!products.ok ? (
        <ErrorState
          title="Could not load products"
          detail={
            products.status === 403 ? 'Your role does not include products.' : 'Reload the page.'
          }
        />
      ) : products.data.items.length === 0 ? (
        <EmptyState title="No products yet" />
      ) : (
        products.data.items.map((p) => <ProductCard key={p.id} p={p} ctx={ctx} />)
      )}
      {ctx.caps.productConfigure && lenderId ? (
        <section className="card">
          <h2>Create a product</h2>
          <OpForm
            op="product.create"
            action={ctx.action}
            returnTo={ctx.returnTo}
            hidden={{ lenderId }}
            submit="Create product"
          >
            <SelectField
              name="categoryKey"
              label="Category"
              required
              options={categories.map((c) => ({ value: c.key, label: c.label }))}
            />
            <TextField name="code" label="Code (capital letters, digits, - and _)" required />
            <TextField name="name" label="Name" required />
          </OpForm>
        </section>
      ) : null}
    </>
  );
}
