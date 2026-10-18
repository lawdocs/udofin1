import { AreaField, SelectField, TextField } from '../onboarding/forms.js';
import { EmptyList, LoadFailure } from '../servicing/common.js';
import { istOrDash } from '../servicing/format.js';
import {
  AccountsNotice,
  PlatformForm,
  ProviderField,
  Section,
  type AccountsContext,
} from './common.js';
import { type Loaded, type ProviderEntry, type ReturnCodeEntry } from './types.js';
import {
  evidenceStatusWords,
  EVIDENCE_STATUSES,
  PROVIDER_KINDS,
  PROVIDER_STATUSES,
  providerKindWords,
  providerStatusWords,
  returnClassWords,
  RETURN_CLASSES,
} from './wording.js';

const words = (list: readonly string[], f: (v: string) => string) =>
  list.map((value) => ({ value, label: f(value) }));

interface Notice {
  done?: boolean | undefined;
  error?: string | undefined;
  result?: string | undefined;
  reasons?: string | undefined;
}

function ProviderFields({ entry }: { entry?: ProviderEntry }) {
  return (
    <>
      {entry ? (
        <input type="hidden" name="provider" value={entry.provider} />
      ) : (
        <TextField
          name="provider"
          label="Key"
          required
          hint="Lower-case letters, digits and underscores, starting with a letter (3 to 50 characters). It cannot be changed later."
        />
      )}
      <TextField
        name="displayName"
        label="Name shown to staff and lenders"
        required
        defaultValue={entry?.displayName}
      />
      <SelectField
        name="kind"
        label="What the provider is used for"
        options={words(PROVIDER_KINDS, providerKindWords)}
        {...(entry ? { defaultValue: entry.kind } : { blank: 'Choose' })}
        required
      />
      <SelectField
        name="status"
        label="Status"
        options={words(PROVIDER_STATUSES, providerStatusWords)}
        {...(entry ? { defaultValue: entry.status } : { blank: 'Choose' })}
        required
      />
      <TextField
        name="authorisationEvidenceRef"
        label="Reference to the authorisation evidence"
        defaultValue={entry?.authorisationEvidenceRef}
        hint="A short title or reference of the document, not its contents."
      />
      <SelectField
        name="evidenceLabel"
        label="What staff know about that evidence"
        options={words(EVIDENCE_STATUSES, evidenceStatusWords)}
        {...(entry ? { defaultValue: entry.evidenceLabel } : { blank: 'Choose' })}
        required
      />
      <AreaField
        name="reason"
        label="Reason"
        hint="Required when you suspend a provider (10 characters or more). Do not type account, phone or identity numbers."
      />
    </>
  );
}

function ProviderCard({ entry, ctx }: { entry: ProviderEntry; ctx: AccountsContext }) {
  return (
    <article className="card">
      <h3>{entry.displayName}</h3>
      <dl className="facts">
        <div>
          <dt>Key</dt>
          <dd>{entry.provider}</dd>
        </div>
        <div>
          <dt>Used for</dt>
          <dd>{providerKindWords(entry.kind)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{providerStatusWords(entry.status)}</dd>
        </div>
        <div>
          <dt>Authorisation evidence</dt>
          <dd>{entry.authorisationEvidenceRef ?? 'No reference recorded'}</dd>
        </div>
        <div>
          <dt>What staff know about it</dt>
          <dd>{evidenceStatusWords(entry.evidenceLabel)}</dd>
        </div>
        {entry.statusReason ? (
          <div>
            <dt>Reason recorded</dt>
            <dd>{entry.statusReason}</dd>
          </div>
        ) : null}
        <div>
          <dt>Last changed</dt>
          <dd>{istOrDash(entry.updatedAt)}</dd>
        </div>
      </dl>
      {ctx.caps.providersManage ? (
        <details>
          <summary>Change or suspend this provider</summary>
          <PlatformForm op="provider.set" action={ctx.action} returnTo={ctx.returnTo}>
            <ProviderFields entry={entry} />
            <button type="submit">Save the provider</button>
          </PlatformForm>
        </details>
      ) : null}
    </article>
  );
}

function ReturnCodeTable({ items }: { items: readonly ReturnCodeEntry[] }) {
  return (
    <table>
      <caption className="sr-only">Return codes and the class staff gave them</caption>
      <thead>
        <tr>
          <th scope="col">Provider</th>
          <th scope="col">Code</th>
          <th scope="col">Class</th>
          <th scope="col">Evidence reference</th>
          <th scope="col">Set on</th>
        </tr>
      </thead>
      <tbody>
        {items.map((r) => (
          <tr key={r.id}>
            <td>{r.provider}</td>
            <td>{r.code}</td>
            <td>{returnClassWords(r.class)}</td>
            <td>{r.evidenceRef}</td>
            <td>{istOrDash(r.setAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ProvidersPage({
  providers,
  returnCodes,
  provider,
  ctx,
  notice,
}: {
  providers: Loaded<{ items: ProviderEntry[] }>;
  returnCodes: Loaded<{ items: ReturnCodeEntry[] }>;
  /** The provider the return-code list is filtered to, if any. */
  provider?: string | undefined;
  ctx: AccountsContext;
  notice: Notice;
}) {
  const list = providers.ok ? providers.data.items : null;
  return (
    <div>
      <h1>Payment providers</h1>
      <p>
        The register of the payment and mandate providers Udofin may use. Nothing is filled in for
        you: an empty register means no provider has been chosen. The evidence label is what a
        member of staff recorded about a source; it is not a statement by Udofin that a provider is
        authorised.
      </p>
      <AccountsNotice {...notice} />

      <Section title="Provider register">
        {!providers.ok ? (
          <LoadFailure what="the provider register" status={providers.status} />
        ) : providers.data.items.length === 0 ? (
          <EmptyList
            title="No providers"
            detail="No provider has been added yet, so no payment configuration can use one."
          />
        ) : (
          providers.data.items.map((entry) => (
            <ProviderCard key={entry.provider} entry={entry} ctx={ctx} />
          ))
        )}
        {ctx.caps.providersManage ? (
          <details>
            <summary>Add a provider</summary>
            <PlatformForm op="provider.set" action={ctx.action} returnTo={ctx.returnTo}>
              <ProviderFields />
              <button type="submit">Add the provider</button>
            </PlatformForm>
          </details>
        ) : (
          <p className="muted">Your role cannot change the register.</p>
        )}
      </Section>

      <Section title="Return code classes">
        <p>
          How each provider’s return codes are grouped. Nothing is pre-filled: a code has no class
          until staff set one with a reference to the source.
        </p>
        <form method="get" action="/providers" className="inline">
          <SelectField
            name="provider"
            label="Provider"
            blank="All providers"
            options={(list ?? []).map((p) => ({ value: p.provider, label: p.displayName }))}
            defaultValue={provider ?? ''}
          />
          <button type="submit" className="secondary">
            Show
          </button>
        </form>
        {!returnCodes.ok ? (
          <LoadFailure what="the return codes" status={returnCodes.status} />
        ) : returnCodes.data.items.length === 0 ? (
          <EmptyList title="No return codes" detail="No class has been set for any return code." />
        ) : (
          <ReturnCodeTable items={returnCodes.data.items} />
        )}
        {ctx.caps.providersManage ? (
          <details>
            <summary>Set the class of a return code</summary>
            <PlatformForm op="returncode.set" action={ctx.action} returnTo={ctx.returnTo}>
              <ProviderField name="provider" label="Provider" providers={list} />
              <TextField
                name="code"
                label="Return code"
                required
                hint="As the provider writes it (letters, digits and . _ : -)."
              />
              <SelectField
                name="class"
                label="Class"
                blank="Choose"
                required
                options={words(RETURN_CLASSES, returnClassWords)}
              />
              <TextField
                name="evidenceRef"
                label="Reference to the source of this class"
                required
                hint="A short title or reference of the provider document."
              />
              <button type="submit">Set the class</button>
            </PlatformForm>
          </details>
        ) : null}
      </Section>
    </div>
  );
}
