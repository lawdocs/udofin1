import { type LenderDocument } from '@udofin/contracts';
import { AreaField, OpForm, SelectField } from '../onboarding/forms.js';
import { label } from '../onboarding/labels.js';
import { type ViewContext } from '../onboarding/views.js';
import { ErrorState } from '../states.js';

type Result<T> = { ok: true; data: T } | { ok: false; status: number; code: string };
export interface InputRow {
  id: string;
  packageVersion: number;
  mode: string;
  validation: string;
  issues: string[];
  submittedAt: string;
}

/** What each check code means, in the lender's words. Unknown codes are shown as their name. */
const ISSUE_TEXT: Readonly<Record<string, string>> = {
  schema_wrong: 'The data does not use the expected format (schema).',
  unknown_field: 'The data contains a field outside the approved structure.',
  apr_missing: 'The APR is missing.',
  apr_mismatch_offer: 'The APR differs from your offer.',
  amount_mismatch_offer: 'The sanctioned amount differs from your offer.',
  tenor_mismatch_offer: 'The loan tenure differs from your offer.',
  rate_mismatch_offer: 'The interest rate differs from your offer.',
  instalment_count_mismatch_offer: 'The number of instalments differs from your offer.',
  instalment_amount_mismatch_offer: 'The instalment amount differs from your offer.',
  instalment_frequency_mismatch_offer: 'The instalment frequency differs from your offer.',
  processing_fee_mismatch_offer: 'The processing fee differs from your offer.',
  processing_fee_missing: 'Your offer has a processing fee but the fee list has none.',
  schedule_missing: 'The repayment schedule is missing.',
  schedule_sequence_invalid: 'The schedule rows are not numbered 1, 2, 3 … or a figure is missing.',
  schedule_date_invalid: 'A due date in the schedule is not a real date.',
  schedule_dates_invalid: 'The due dates do not increase.',
  schedule_outstanding_invalid:
    'The first outstanding principal differs from the sanctioned amount.',
  schedule_balance_broken:
    "A row's outstanding principal does not follow from the row before. Add a rounding note if this is rounding.",
  schedule_row_inconsistent:
    "A row's instalment is not principal plus interest. Add a rounding note if this is rounding.",
  schedule_principal_sum_mismatch:
    'The principal in the schedule does not add up to the sanctioned amount. Add a rounding note if this is rounding.',
  schedule_interest_sum_mismatch:
    'The interest in the schedule does not add up to the total interest. Add a rounding note if this is rounding.',
  schedule_count_mismatch: 'The number of schedule rows differs from the number of instalments.',
  fees_missing: 'The fee list is missing (state "noFees": true if there are none).',
  fee_invalid: 'A fee needs exactly one of an amount or a percentage, and its payee and timing.',
  fees_split_mismatch: 'Fees to the lender plus fees to a third party differ from the fee total.',
  fees_total_mismatch: 'The fee lines do not add up to the stated fee totals.',
  net_disbursed_mismatch:
    'The net disbursed amount differs from the sanctioned amount less the fees.',
  total_payable_inconsistent:
    'The total payable differs from the sanctioned amount plus the total interest. Add a rounding note if this is rounding.',
  computation_incomplete: 'The APR computation sheet is incomplete.',
  floating_table_incomplete: 'A floating or hybrid rate needs the reference-benchmark table.',
  floating_rate_inconsistent: 'The final rate is not the benchmark plus the spread.',
  rate_type_missing: 'The interest-rate type is missing.',
  interest_rate_invalid: 'The interest rate is missing or out of range.',
  penal_charges_missing: 'The penal charges for delayed payment are missing.',
  contingent_charges_incomplete:
    'The foreclosure, switching or other penal charges are not stated (use "notApplicable": true where none).',
  part2_incomplete: 'Part 2 (clauses on recovery agents and grievance redressal) is incomplete.',
  nodal_officer_incomplete: "The nodal grievance officer's phone or email is missing.",
  transfer_flag_missing: 'Whether the loan may be transferred or securitised is not stated.',
  cooling_off_missing: 'The cooling-off period (at least one day) is missing.',
  proposal_no_invalid: 'The proposal number format is not valid.',
  kfs_validity_invalid: 'The validity start and end are missing or the end is not after the start.',
};
const issueText = (code: string) => ISSUE_TEXT[code] ?? label(code);

const stamp = (value: string | null | undefined) =>
  value ? `${value.slice(0, 16).replace('T', ' ')} UTC` : '—';

const TYPE_LABEL: Record<string, string> = {
  kfs: 'Key Facts Statement',
  loan_agreement: 'Loan agreement',
};

export function DocumentsSection({
  applicationId,
  offer,
  documents,
  inputs,
  ctx,
}: {
  applicationId: string;
  /** The offer revision the documents are for (null when there is no current offer). */
  offer: { offerId: string; revision: number; status: string } | null;
  documents: Result<{ items: LenderDocument[] }>;
  inputs: Result<{ items: InputRow[] }> | undefined;
  ctx: ViewContext;
}) {
  const canPrepare = ctx.caps.documentPrepare === true;
  const canApprove = ctx.caps.documentApprove === true;
  const accepted = inputs?.ok
    ? inputs.data.items.find((i) => i.validation === 'accepted' && i.mode === 'data')
    : undefined;
  const declared = inputs?.ok
    ? inputs.data.items.find((i) => i.validation === 'accepted' && i.mode === 'declared_for_upload')
    : undefined;
  const latestVersion = inputs?.ok
    ? Math.max(0, ...inputs.data.items.map((i) => i.packageVersion))
    : 0;
  return (
    <section>
      <h2>Key Facts Statement and documents</h2>
      <p>
        Udofin turns the figures you supply into the RBI standard Key Facts Statement exactly as you
        give them. It never changes, rounds or recalculates a figure; a difference from your offer
        is flagged for you to correct. A document reaches the borrower only after a person in your
        organisation approves the exact file and issues it.
      </p>
      {!offer ? (
        <p>There is no current offer for this application, so no document can be prepared.</p>
      ) : null}
      {offer ? (
        <>
          <h3>KFS data for offer revision {offer.revision}</h3>
          {!inputs ? null : !inputs.ok ? (
            <ErrorState title="Could not load the KFS data submissions" detail="Reload the page." />
          ) : inputs.data.items.length === 0 ? (
            <p>No KFS data has been submitted yet.</p>
          ) : (
            <ul>
              {inputs.data.items.map((i) => (
                <li key={i.id}>
                  Version {i.packageVersion} (
                  {i.mode === 'data' ? 'full data' : 'facts of your own file'}) —{' '}
                  {i.validation === 'accepted' ? 'accepted' : 'held'}
                  {i.packageVersion !== latestVersion ? ' (older)' : ''}, {stamp(i.submittedAt)}
                  {i.issues.length > 0 ? (
                    <ul>
                      {i.issues.map((code) => (
                        <li key={code}>{issueText(code)}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {canPrepare ? (
            <>
              <OpForm
                op="document.kfs_data"
                action={ctx.action}
                returnTo={ctx.returnTo}
                hidden={{ offerId: offer.offerId }}
                submit="Submit KFS data"
              >
                <SelectField
                  name="mode"
                  label="What are you submitting?"
                  options={[
                    { value: 'data', label: 'Full KFS data (Udofin generates the document)' },
                    {
                      value: 'declared_for_upload',
                      label: 'The key facts of a KFS file you produced yourself',
                    },
                  ]}
                  defaultValue="data"
                />
                <AreaField
                  name="data"
                  label="Data as JSON (kfs_data_v1 or kfs_declared_v1, see docs/api/documents.md)"
                  required
                  hint="Figures in paise and basis points, exactly as your system states them."
                />
              </OpForm>
              {accepted ? (
                <OpForm
                  op="document.generate"
                  action={ctx.action}
                  returnTo={ctx.returnTo}
                  hidden={{ offerId: offer.offerId, inputId: accepted.id }}
                  submit="Prepare a draft document"
                >
                  <SelectField
                    name="documentType"
                    label="Document"
                    options={[
                      { value: 'kfs', label: 'Key Facts Statement' },
                      {
                        value: 'loan_agreement',
                        label: 'Loan agreement (after the borrower accepted)',
                      },
                    ]}
                    defaultValue="kfs"
                  />
                  <SelectField
                    name="language"
                    label="Language (needs an approved template)"
                    options={[
                      { value: 'en', label: 'English' },
                      { value: 'hi', label: 'Hindi' },
                    ]}
                    defaultValue="en"
                  />
                </OpForm>
              ) : null}
              {declared ? (
                <form action={ctx.action} className="form" encType="multipart/form-data">
                  <input type="hidden" name="op" value="document.kfs_upload" />
                  <input type="hidden" name="key" value={`ui-${crypto.randomUUID()}`} />
                  <input type="hidden" name="returnTo" value={ctx.returnTo} />
                  <input type="hidden" name="offerId" value={offer.offerId} />
                  <input type="hidden" name="inputId" value={declared.id} />
                  <div className="field">
                    <label htmlFor="kfs-file">Your own KFS file (PDF, at most 8 MiB)</label>
                    <input
                      id="kfs-file"
                      name="file"
                      type="file"
                      accept="application/pdf"
                      required
                    />
                  </div>
                  <button type="submit">Register the file</button>
                </form>
              ) : null}
            </>
          ) : (
            <p>You can read this section, but your role does not include preparing documents.</p>
          )}
        </>
      ) : null}

      <h3>Documents</h3>
      {!documents.ok ? (
        <ErrorState title="Could not load the documents" detail="Reload the page." />
      ) : documents.data.items.length === 0 ? (
        <p>No document has been prepared yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Document</th>
              <th>Status</th>
              <th>Proposal no.</th>
              <th>KFS valid until</th>
              <th>File</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {documents.data.items.map((d) => (
              <tr key={d.id}>
                <td>
                  {TYPE_LABEL[d.documentType] ?? label(d.documentType)} · version {d.version} (
                  {d.language}){d.sourceMode === 'lender_uploaded' ? ' · your own file' : ''}
                </td>
                <td>
                  {label(d.approvalStatus)} · {label(d.issuanceStatus)}
                </td>
                <td>{d.proposalNo ?? '—'}</td>
                <td>{stamp(d.kfsValidUntil)}</td>
                <td>
                  <a
                    href={`/applications/${applicationId}/documents/${d.id}/file`}
                    target="_blank"
                    rel="noopener"
                  >
                    Open the file
                  </a>
                  <br />
                  <small title={d.sha256}>SHA-256 {d.sha256.slice(0, 16)}…</small>
                </td>
                <td>
                  {canApprove &&
                  d.approvalStatus === 'draft' &&
                  d.issuanceStatus === 'not_issued' ? (
                    <>
                      <OpForm
                        op="document.approve"
                        action={ctx.action}
                        returnTo={ctx.returnTo}
                        hidden={{ id: d.id, sha256: d.sha256 }}
                        submit="Approve this exact file"
                        inline
                      >
                        <label>
                          <input type="checkbox" name="reviewed" /> I opened and reviewed this file
                        </label>
                      </OpForm>
                      <OpForm
                        op="document.reject"
                        action={ctx.action}
                        returnTo={ctx.returnTo}
                        hidden={{ id: d.id }}
                        submit="Reject"
                        secondary
                        inline
                      >
                        <SelectField name="reason" label="Reason" options={REASON_OPTIONS} />
                      </OpForm>
                    </>
                  ) : null}
                  {canApprove &&
                  d.approvalStatus === 'lender_approved' &&
                  d.issuanceStatus === 'not_issued' ? (
                    <OpForm
                      op="document.issue"
                      action={ctx.action}
                      returnTo={ctx.returnTo}
                      hidden={{ id: d.id }}
                      submit="Issue to the borrower"
                      inline
                    />
                  ) : null}
                  {canApprove &&
                  (d.issuanceStatus === 'issued' || d.issuanceStatus === 'not_issued') &&
                  d.approvalStatus !== 'rejected' ? (
                    <OpForm
                      op="document.withdraw"
                      action={ctx.action}
                      returnTo={ctx.returnTo}
                      hidden={{ id: d.id }}
                      submit="Withdraw"
                      secondary
                      inline
                    >
                      <SelectField name="reason" label="Reason" options={REASON_OPTIONS} />
                    </OpForm>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const REASON_OPTIONS = [
  { value: 'prepared_in_error', label: 'Prepared in error' },
  { value: 'figures_changed', label: 'Figures changed' },
  { value: 'offer_changed', label: 'Offer changed' },
  { value: 'other', label: 'Other' },
] as const;
