import {
  LS_ANOMALY_SEVERITIES,
  LS_CONFLICT_STATUSES,
  LS_CONNECTION_KINDS,
  LS_IMPORT_KINDS,
  type LsImportBatch,
} from '@udofin/contracts';
import { AreaField, OpForm, SelectField, TextField } from '../onboarding/forms.js';
import {
  CheckField,
  EmptyList,
  LoadFailure,
  type Loaded,
  Paging,
  Section,
  ServicingNav,
  ServicingNotice,
  type ServicingContext,
} from './common.js';
import {
  lendersWith,
  lenderNameOf,
  listHref,
  mayIn,
  withoutCursor,
  type ListQuery,
} from './data.js';
import { formatCount, formatIst, formatRupees } from './format.js';
import { RowErrorsTable } from './import-errors.js';
import {
  type LsAnomaly,
  type LsAnomalyPage,
  type LsConflict,
  type LsConflictPage,
  type LsImportBatchPage,
  type LsImportDetail,
  type LsSyncStatus,
} from './types.js';
import { ImportStageForm, type StageAction } from './stage-form.js';
import {
  anomalyWords,
  batchStatusWords,
  CAPABILITY_KEYS,
  capabilityWords,
  conflictReasonWords,
  conflictStatusWords,
  confirmedVersionWords,
  connectionKindWords,
  connectionStatusWords,
  countLabelWords,
  importKindWords,
  loanStatusWords,
  recordTypeWords,
  severityWords,
  sourceSystemWords,
} from './wording.js';

const STATUS_FILTER = (statuses: readonly string[], words: (s: string) => string) =>
  statuses.map((s) => ({ value: s, label: words(s) }));

// ---------------------------------------------------------------------------------------------------------------
// Imports and sync
// ---------------------------------------------------------------------------------------------------------------
const COUNT_ORDER = [
  'new',
  'unchanged',
  'duplicate',
  'changed',
  'conflict',
  'error',
  'quarantined',
  'ignoredOlder',
] as const;

const CORRECTABLE_WORDS: Readonly<Record<string, string>> = {
  invalid: 'not importable',
  rejected: 'discarded',
  failed: 'failed',
};

const MODE_WORDS: Readonly<Record<string, string>> = {
  mock: 'Mock mode: for testing only, never for real data',
  sandbox: 'Sandbox mode: for testing only',
};

/** Earlier files this upload may correct: only invalid, discarded or failed ones. */
export function correctionOptions(batches: readonly LsImportBatch[]) {
  return batches
    .filter((b) => Object.hasOwn(CORRECTABLE_WORDS, b.status))
    .map((b) => ({
      id: b.id,
      label: `${importKindWords(b.kind)}, ${formatCount(b.rowCount)} records, sent ${formatIst(b.uploadedAt)} (${CORRECTABLE_WORDS[b.status] ?? ''})`,
    }));
}

function ConnectionForm({
  item,
  ctx,
}: {
  item: LsSyncStatus['items'][number];
  ctx: ServicingContext;
}) {
  const c = item.connection;
  const usable = (kind: string) => kind === 'file_import' || kind === 'manual';
  return (
    <details>
      <summary>{c ? 'Change the connection' : 'Set up the connection'}</summary>
      <OpForm
        op="servicing.connection.set"
        action={ctx.action}
        returnTo={ctx.returnTo}
        hidden={{ lenderId: item.lenderId }}
        submit="Save the connection"
      >
        <SelectField
          name="kind"
          label="How reports reach Udofin"
          options={LS_CONNECTION_KINDS.filter(usable).map((k) => ({
            value: k,
            label: connectionKindWords(k),
          }))}
          defaultValue={c && usable(c.kind) ? c.kind : 'file_import'}
        />
        <SelectField
          name="status"
          label="Connection status"
          options={['draft', 'active', 'paused'].map((s) => ({
            value: s,
            label: connectionStatusWords(s),
          }))}
          defaultValue={c && c.status !== 'blocked_unverified' ? c.status : 'draft'}
        />
        <TextField
          name="stalenessThresholdMinutes"
          label="A report is stale after this many minutes (5 to 43,200)"
          type="number"
          defaultValue={String(c?.stalenessThresholdMinutes ?? 1440)}
          required
        />
        <fieldset>
          <legend>What your system can do (your own declaration; Udofin has not tested it)</legend>
          {CAPABILITY_KEYS.map((key) => (
            <CheckField
              key={key}
              name={`cap_${key}`}
              label={capabilityWords(key)}
              checked={c?.capabilities[key as keyof typeof c.capabilities] === true}
            />
          ))}
        </fieldset>
      </OpForm>
    </details>
  );
}

function SyncCard({ item, ctx }: { item: LsSyncStatus['items'][number]; ctx: ServicingContext }) {
  const c = item.connection;
  const name = lenderNameOf(ctx.grants, item.lenderId);
  const declared = c
    ? CAPABILITY_KEYS.filter((k) => c.capabilities[k as keyof typeof c.capabilities] === true)
    : [];
  return (
    <section className="card" aria-label={`Sync status for ${name}`}>
      <h3>{name}</h3>
      {c ? (
        <dl className="facts">
          <div>
            <dt>Connection</dt>
            <dd>{connectionKindWords(c.kind)}</dd>
          </div>
          <div>
            <dt>Connection status</dt>
            <dd>{connectionStatusWords(c.status)}</dd>
          </div>
          {MODE_WORDS[c.providerMode] ? (
            <div>
              <dt>Mode</dt>
              <dd>{MODE_WORDS[c.providerMode]}</dd>
            </div>
          ) : null}
          <div>
            <dt>Stale after</dt>
            <dd>{formatCount(c.stalenessThresholdMinutes)} minutes</dd>
          </div>
          <div>
            <dt>Last report or file applied</dt>
            <dd>{c.lastSuccessAt ? formatIst(c.lastSuccessAt) : 'None yet'}</dd>
          </div>
          <div>
            <dt>Declared capabilities</dt>
            <dd>
              {declared.length === 0
                ? 'None declared'
                : declared.map((k) => capabilityWords(k)).join(', ')}
            </dd>
          </div>
        </dl>
      ) : (
        <p>No connection has been set up for this lender, so no file can be uploaded yet.</p>
      )}
      <dl className="facts">
        <div>
          <dt>Loans held</dt>
          <dd>{formatCount(item.loans.total)}</dd>
        </div>
        <div>
          <dt>Loans with no report yet</dt>
          <dd>{formatCount(item.loans.neverReported)}</dd>
        </div>
        <div>
          <dt>Loans with no report or an old report (stale)</dt>
          <dd>{formatCount(item.loans.stale)}</dd>
        </div>
        <div>
          <dt>Loans with a conflict waiting</dt>
          <dd>{formatCount(item.loans.withOpenConflict)}</dd>
        </div>
        <div>
          <dt>Loans with a warning on the newest report</dt>
          <dd>{formatCount(item.loans.withWarning)}</dd>
        </div>
        <div>
          <dt>Newest report</dt>
          <dd>
            {item.newestReportedAsOf
              ? `As reported on ${formatIst(item.newestReportedAsOf)}`
              : 'None yet'}
          </dd>
        </div>
      </dl>
      {mayIn(ctx.grants, item.lenderId, 'syncManage') ? (
        <ConnectionForm item={item} ctx={ctx} />
      ) : (
        <p className="muted">Your role cannot change this connection.</p>
      )}
    </section>
  );
}

export function SyncPage({
  status,
  imports,
  corrections,
  query,
  ctx,
  stageAction,
  correctionOf,
  done,
  error,
}: {
  status: Loaded<LsSyncStatus>;
  imports: Loaded<LsImportBatchPage>;
  /** Earlier invalid, discarded or failed files, which a new upload may correct. */
  corrections: readonly LsImportBatch[];
  query: ListQuery;
  ctx: ServicingContext;
  stageAction: StageAction;
  correctionOf?: string | undefined;
  done?: boolean;
  error?: string | undefined;
}) {
  const uploaders = lendersWith(ctx.grants, 'manualEntry');
  return (
    <div>
      <h1>Imports and sync</h1>
      <ServicingNav current="/imports" />
      <p>
        Your lender system is the system of record. Udofin keeps what it reported, with your times,
        and calculates nothing. Files are all or nothing: nothing is applied unless every row is
        valid.
      </p>
      <ServicingNotice done={done === true} error={error} />

      <Section title="Connection and sync status">
        {!status.ok ? (
          <LoadFailure what="the sync status" status={status.status} />
        ) : status.data.items.length === 0 ? (
          <EmptyList
            title="No sync status yet"
            detail="It appears once a lender has a connection or a loan."
          />
        ) : (
          status.data.items.map((item) => <SyncCard key={item.lenderId} item={item} ctx={ctx} />)
        )}
      </Section>

      <section className="card" id="upload" aria-labelledby="upload-title">
        <h2 id="upload-title">Upload a file</h2>
        {uploaders.length === 0 ? (
          <p>You can read this page, but your role does not include uploading files.</p>
        ) : (
          <>
            <p>
              The file is checked as a whole and a preview is shown. Nothing is applied by
              uploading. Applying is a separate step, and you can discard the preview. If any row is
              wrong, nothing is applied and the rows at fault are listed (row number, kind of
              problem and column, never the values), so you can correct the file and send it again.
            </p>
            <ImportStageForm
              action={stageAction}
              lenders={uploaders.map((g) => ({ id: g.lenderId, name: g.name }))}
              corrections={correctionOptions(corrections)}
              correctionOf={correctionOf}
            />
          </>
        )}
      </section>

      <Section title="Files received">
        <form method="get" action="/imports" className="inline">
          <SelectField
            name="kind"
            label="Kind"
            blank="All kinds"
            options={LS_IMPORT_KINDS.map((k) => ({ value: k, label: importKindWords(k) }))}
            defaultValue={query.kind ?? ''}
          />
          <SelectField
            name="status"
            label="Status"
            blank="All statuses"
            options={STATUS_FILTER(
              ['uploaded', 'previewed', 'invalid', 'committed', 'rejected', 'failed'],
              (s) => batchStatusWords(s),
            )}
            defaultValue={query.status ?? ''}
          />
          <button type="submit" className="secondary">
            Show
          </button>
        </form>
        {!imports.ok ? (
          <LoadFailure what="the files received" status={imports.status} />
        ) : imports.data.items.length === 0 ? (
          <EmptyList title="No files yet" detail="A file appears here once it has been checked." />
        ) : (
          <>
            <table>
              <caption>Files received, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Sent</th>
                  <th scope="col">Lender</th>
                  <th scope="col">Contains</th>
                  <th scope="col">Records</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {imports.data.items.map((b) => (
                  <tr key={b.id}>
                    <td>{formatIst(b.uploadedAt)}</td>
                    <td>{lenderNameOf(ctx.grants, b.lenderId)}</td>
                    <td>{importKindWords(b.kind)}</td>
                    <td>{formatCount(b.rowCount)}</td>
                    <td>{batchStatusWords(b.status)}</td>
                    <td>
                      <a href={`/imports/${b.id}`}>Open the result</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Paging
              nextHref={
                imports.data.nextCursor
                  ? listHref('/imports', { ...query, cursor: imports.data.nextCursor })
                  : null
              }
              firstHref={listHref('/imports', withoutCursor(query))}
              hasCursor={query.cursor !== undefined}
              noun="files"
            />
          </>
        )}
      </Section>
    </div>
  );
}

/** One file's result: counts, problems, and the separate steps to apply or discard it. */
export function ImportDetailPage({
  detail,
  ctx,
  existing,
  done,
  error,
}: {
  detail: Loaded<LsImportDetail>;
  ctx: ServicingContext;
  existing?: boolean;
  done?: boolean;
  error?: string | undefined;
}) {
  if (!detail.ok)
    return (
      <div>
        <h1>Import result</h1>
        <ServicingNav current="/imports" />
        <LoadFailure what="this import" status={detail.status} />
      </div>
    );
  const { batch, errors, errorsTruncated } = detail.data;
  // A stored batch is always numbered by record position (the API says so); the file lines are only known for a refused file.
  const rowNumbering = detail.data.rowNumbering ?? 'record_position';
  const canApply = mayIn(ctx.grants, batch.lenderId, 'syncManage');
  const canDiscard = canApply || mayIn(ctx.grants, batch.lenderId, 'manualEntry');
  const correctable =
    batch.status === 'invalid' || batch.status === 'rejected' || batch.status === 'failed';
  return (
    <div>
      <h1>Import result</h1>
      <ServicingNav current="/imports" />
      <ServicingNotice done={done === true} error={error} />
      <section className="state" role="status">
        <h2>{batchStatusWords(batch.status)}</h2>
        {existing ? (
          <p>This exact file was already received earlier, so this is the earlier result.</p>
        ) : null}
        <p>Nothing is applied unless every row is valid.</p>
      </section>
      <dl className="facts">
        <div>
          <dt>Lender</dt>
          <dd>{lenderNameOf(ctx.grants, batch.lenderId)}</dd>
        </div>
        <div>
          <dt>Contains</dt>
          <dd>{importKindWords(batch.kind)}</dd>
        </div>
        <div>
          <dt>Records in the file</dt>
          <dd>{formatCount(batch.rowCount)}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{formatCount(batch.byteSize)} bytes</dd>
        </div>
        <div>
          <dt>Sent</dt>
          <dd>{formatIst(batch.uploadedAt)}</dd>
        </div>
        <div>
          <dt>File fingerprint (SHA-256)</dt>
          <dd title={batch.fileSha256}>{batch.fileSha256.slice(0, 16)}…</dd>
        </div>
        {batch.committedAt ? (
          <div>
            <dt>Applied</dt>
            <dd>{formatIst(batch.committedAt)}</dd>
          </div>
        ) : null}
        {batch.rejectedAt ? (
          <div>
            <dt>Discarded</dt>
            <dd>{formatIst(batch.rejectedAt)}</dd>
          </div>
        ) : null}
        {batch.failedAt ? (
          <div>
            <dt>Applying failed</dt>
            <dd>{formatIst(batch.failedAt)}</dd>
          </div>
        ) : null}
      </dl>

      <Section title="What the preview found">
        <table>
          <caption>Records by result</caption>
          <thead>
            <tr>
              <th scope="col">Result</th>
              <th scope="col">Records</th>
            </tr>
          </thead>
          <tbody>
            {COUNT_ORDER.map((key) => (
              <tr key={key}>
                <th scope="row">{countLabelWords(key)}</th>
                <td>{formatCount(batch.counts[key])}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {batch.appliedCounts ? (
          <table>
            <caption>What applying did</caption>
            <thead>
              <tr>
                <th scope="col">Result</th>
                <th scope="col">Records</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(batch.appliedCounts).map(([key, count]) => (
                <tr key={key}>
                  <th scope="row">{countLabelWords(key)}</th>
                  <td>{formatCount(count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <RowErrorsTable errors={errors} truncated={errorsTruncated} rowNumbering={rowNumbering} />
      </Section>

      {batch.status === 'previewed' ? (
        <Section title="Apply or discard">
          {canApply ? (
            <OpForm
              op="servicing.import.commit"
              action={ctx.action}
              returnTo={ctx.returnTo}
              hidden={{ id: batch.id }}
              submit="Apply this file"
            >
              <p>
                Applying records every row of this file in one step, or none of them if anything
                fails. It does not change your lender system.
              </p>
              <CheckField
                name="reviewed"
                label="I have reviewed this preview and want to apply it"
              />
            </OpForm>
          ) : (
            <p>Your role cannot apply a file.</p>
          )}
          {canDiscard ? (
            <OpForm
              op="servicing.import.reject"
              action={ctx.action}
              returnTo={ctx.returnTo}
              hidden={{ id: batch.id }}
              submit="Discard this file"
              secondary
            >
              <AreaField
                name="reason"
                label="Why you are discarding it (10 to 1,000 characters, no personal details)"
                required
              />
            </OpForm>
          ) : (
            <p>Your role cannot discard a file.</p>
          )}
        </Section>
      ) : null}
      {correctable ? (
        <p>
          <a href={`/imports?correct=${batch.id}#upload`}>Upload a corrected file</a>
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Conflicts and flags
// ---------------------------------------------------------------------------------------------------------------
const EVIDENCE_LABELS = [
  { value: 'lms_reference', label: 'Reference in your lender system' },
  { value: 'ticket_reference', label: 'Support ticket or case' },
  { value: 'report_reference', label: 'Report or file you compared' },
  { value: 'document_reference', label: 'Document reference' },
] as const;

function ResolveForm({ conflict, ctx }: { conflict: LsConflict; ctx: ServicingContext }) {
  return (
    <details>
      <summary>Resolve this conflict</summary>
      <OpForm
        op="servicing.conflict.resolve"
        action={ctx.action}
        returnTo={ctx.returnTo}
        hidden={{ id: conflict.id }}
        submit="Record the resolution"
      >
        <p>
          Resolving records which report your organisation confirms. Neither report is changed,
          applied, hidden or deleted.
        </p>
        <SelectField
          name="confirmedVersion"
          label="Which report does your organisation confirm?"
          blank="Choose a report"
          required
          options={[
            {
              value: 'existing',
              label: `The report already held (as reported ${formatIst(conflict.existingReportedAsOf)})`,
            },
            {
              value: 'incoming',
              label: `The report that arrived later (as reported ${formatIst(conflict.incomingReportedAsOf)})`,
            },
          ]}
        />
        <AreaField name="note" label="Why (10 to 1,000 characters, no personal details)" required />
        <fieldset>
          <legend>What you reviewed: at least one short reference, no personal details</legend>
          {[1, 2, 3].map((slot) => (
            <div key={slot}>
              <SelectField
                name={`evidenceLabel${String(slot)}`}
                label={`Reference ${String(slot)}: kind`}
                blank="None"
                options={EVIDENCE_LABELS}
              />
              <TextField
                name={`evidenceValue${String(slot)}`}
                label={`Reference ${String(slot)}: the reference itself`}
              />
            </div>
          ))}
        </fieldset>
      </OpForm>
    </details>
  );
}

export function ConflictList({
  conflicts,
  ctx,
}: {
  conflicts: readonly LsConflict[];
  ctx: ServicingContext;
}) {
  return (
    <div>
      {conflicts.map((c) => {
        const manage = mayIn(ctx.grants, c.lenderId, 'syncManage');
        return (
          <article key={c.id} className="card">
            <h3>{recordTypeWords(c.recordType)}: two reports differ</h3>
            <p>{conflictReasonWords(c.conflictReason)}</p>
            <dl className="facts">
              <div>
                <dt>Status</dt>
                <dd>{conflictStatusWords(c.status)}</dd>
              </div>
              <div>
                <dt>Your record id</dt>
                <dd>{c.sourceRecordId}</dd>
              </div>
              <div>
                <dt>Report already held</dt>
                <dd>As reported {formatIst(c.existingReportedAsOf)}</dd>
              </div>
              <div>
                <dt>Report that arrived later</dt>
                <dd>As reported {formatIst(c.incomingReportedAsOf)}</dd>
              </div>
              <div>
                <dt>Received by Udofin</dt>
                <dd>
                  {formatIst(c.receivedAt)}, from {sourceSystemWords(c.sourceSystem)}
                </dd>
              </div>
              {c.acknowledgedAt ? (
                <div>
                  <dt>Acknowledged</dt>
                  <dd>{formatIst(c.acknowledgedAt)}</dd>
                </div>
              ) : null}
              {c.resolvedAt && c.confirmedVersion ? (
                <div>
                  <dt>Resolved</dt>
                  <dd>
                    {formatIst(c.resolvedAt)}: your organisation confirmed{' '}
                    {confirmedVersionWords(c.confirmedVersion).toLowerCase()}.
                    {c.resolutionNote ? ` Note: ${c.resolutionNote}` : ''}
                  </dd>
                </div>
              ) : null}
            </dl>
            <p>
              <a href={`/loans/${c.loanAccountId}`}>Open the loan</a>
            </p>
            {c.status === 'open' && manage ? (
              <OpForm
                op="servicing.conflict.acknowledge"
                action={ctx.action}
                returnTo={ctx.returnTo}
                hidden={{ id: c.id }}
                submit="Acknowledge: I have seen this"
                secondary
              />
            ) : null}
            {c.status === 'acknowledged' && manage ? <ResolveForm conflict={c} ctx={ctx} /> : null}
            {c.status !== 'resolved' && !manage ? (
              <p className="muted">Your role cannot acknowledge or resolve conflicts.</p>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

export function ConflictsPage({
  page,
  query,
  ctx,
  done,
  error,
}: {
  page: Loaded<LsConflictPage>;
  query: ListQuery;
  ctx: ServicingContext;
  done?: boolean;
  error?: string | undefined;
}) {
  return (
    <div>
      <h1>Conflicts</h1>
      <ServicingNav current="/imports/conflicts" />
      <p>
        A conflict is the same record reported twice with different content. Udofin keeps both and
        changes neither. Acknowledging says you have seen it; resolving records which report your
        organisation confirms.
      </p>
      <ServicingNotice done={done === true} error={error} />
      <form method="get" action="/imports/conflicts" className="inline">
        <SelectField
          name="status"
          label="Status"
          blank="All"
          options={STATUS_FILTER(LS_CONFLICT_STATUSES, conflictStatusWords)}
          defaultValue={query.status ?? ''}
        />
        <button type="submit" className="secondary">
          Show
        </button>
      </form>
      {!page.ok ? (
        <LoadFailure what="the conflicts" status={page.status} />
      ) : page.data.items.length === 0 ? (
        <EmptyList title="No conflicts" detail="Nothing matches this filter." />
      ) : (
        <>
          <ConflictList conflicts={page.data.items} ctx={ctx} />
          <Paging
            nextHref={
              page.data.nextCursor
                ? listHref('/imports/conflicts', { ...query, cursor: page.data.nextCursor })
                : null
            }
            firstHref={listHref('/imports/conflicts', withoutCursor(query))}
            hasCursor={query.cursor !== undefined}
            noun="conflicts"
          />
        </>
      )}
    </div>
  );
}

function AnomalyDetails({ a }: { a: LsAnomaly }) {
  const before = [
    a.previousStatus ? loanStatusWords(a.previousStatus) : null,
    a.previousAmountMinor !== null ? formatRupees(a.previousAmountMinor) : null,
  ].filter((x) => x !== null);
  const after = [
    a.reportedStatus ? loanStatusWords(a.reportedStatus) : null,
    a.reportedAmountMinor !== null ? formatRupees(a.reportedAmountMinor) : null,
  ].filter((x) => x !== null);
  return (
    <>
      {before.length > 0 ? <p>Held before: {before.join(', ')}.</p> : null}
      {after.length > 0 ? <p>Newly reported: {after.join(', ')}.</p> : null}
    </>
  );
}

export function AnomalyList({ anomalies }: { anomalies: readonly LsAnomaly[] }) {
  return (
    <div>
      {anomalies.map((a) => (
        <article key={a.id} className="card">
          <h3>
            {severityWords(a.severity)}: {anomalyWords(a.kind)}
          </h3>
          <AnomalyDetails a={a} />
          <p className="muted">
            Flagged for you to check. Nothing was corrected; the figures are as your system reported
            them on {formatIst(a.reportedAsOf)} (from {sourceSystemWords(a.sourceSystem)}). Flagged
            by Udofin on {formatIst(a.detectedAt)}.
          </p>
          <p>
            <a href={`/loans/${a.loanAccountId}`}>Open the loan</a>
          </p>
        </article>
      ))}
    </div>
  );
}

export function AnomaliesPage({ page, query }: { page: Loaded<LsAnomalyPage>; query: ListQuery }) {
  return (
    <div>
      <h1>Flags on reports</h1>
      <ServicingNav current="/imports/anomalies" />
      <p>
        A flag marks something in a report that looks unusual next to what was held. It is shown for
        your attention only: Udofin does not correct, hide or act on it.
      </p>
      <form method="get" action="/imports/anomalies" className="inline">
        <SelectField
          name="severity"
          label="Kind of flag"
          blank="All"
          options={STATUS_FILTER(LS_ANOMALY_SEVERITIES, severityWords)}
          defaultValue={query.severity ?? ''}
        />
        <button type="submit" className="secondary">
          Show
        </button>
      </form>
      {!page.ok ? (
        <LoadFailure what="the flags" status={page.status} />
      ) : page.data.items.length === 0 ? (
        <EmptyList title="No flags" detail="Nothing matches this filter." />
      ) : (
        <>
          <AnomalyList anomalies={page.data.items} />
          <Paging
            nextHref={
              page.data.nextCursor
                ? listHref('/imports/anomalies', { ...query, cursor: page.data.nextCursor })
                : null
            }
            firstHref={listHref('/imports/anomalies', withoutCursor(query))}
            hasCursor={query.cursor !== undefined}
            noun="flags"
          />
        </>
      )}
    </div>
  );
}
