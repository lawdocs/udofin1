import { AreaField, TextField } from '../onboarding/forms.js';
import { CheckInput } from '../reminders/fields.js';
import { LoadFailure } from '../servicing/common.js';
import { istOrDash } from '../servicing/format.js';
import {
  AccountsNav,
  AccountsNotice,
  PlatformForm,
  Section,
  whoWords,
  type AccountsContext,
} from './common.js';
import { mayAttestOwnList, mayWithdrawOwnList } from './data.js';
import { type Loaded, type OwnListState } from './types.js';
import { ownListEventWords } from './wording.js';

interface Notice {
  done?: boolean | undefined;
  error?: string | undefined;
  result?: string | undefined;
  reasons?: string | undefined;
}

/**
 * Whether the list of accounts that Udofin and its group companies own is attested complete, and the forms to attest it and to
 * withdraw the attestation. The attestation is a recorded statement by one member of staff with a reference to the evidence. It
 * is not proof and not a finding by anybody else, and the page says so; the API and the database decide who may make it and
 * whether the list looks complete enough to attest.
 */
export function OwnAccountListPage({
  state,
  ctx,
  notice,
}: {
  state: Loaded<OwnListState>;
  ctx: AccountsContext;
  notice: Notice;
}) {
  return (
    <div>
      <h1>Own-account list</h1>
      <AccountsNav current="/accounts/own-accounts" />
      <p>
        Udofin and its group companies have bank accounts of their own. They are registered in the
        account registry, so that no lender’s account can be mistaken for one of them. Attesting
        records that this list is complete. Until it is attested, no lender account can be verified
        or linked, and payments and mandates cannot be switched on for any lender.
      </p>
      <p>
        An attestation is the platform’s own statement, made by one member of staff. It is not
        proof, and it is only as good as the evidence you name: say what the list was reconciled
        against. After a change of key version, the list has to be attested again.
      </p>
      <AccountsNotice {...notice} />
      {!state.ok ? (
        <LoadFailure what="the own-account list" status={state.status} />
      ) : (
        <>
          <StateSection state={state.data} ctx={ctx} />
          <EventsSection state={state.data} ctx={ctx} />
          <ActionsSection state={state.data} ctx={ctx} />
        </>
      )}
    </div>
  );
}

function StateSection({ state, ctx }: { state: OwnListState; ctx: AccountsContext }) {
  const latest = state.events[0];
  return (
    <Section title="Where it stands">
      {state.keyVersion === null ? (
        <p>
          <strong>Nothing to attest yet.</strong> No fingerprint key version is active. Approve a
          key version first (see Format rules and key versions).
        </p>
      ) : state.attested ? (
        <>
          <p>
            <strong>Attested</strong> for key version {state.keyVersion}.
          </p>
          {latest && latest.eventKind === 'attested' ? (
            <dl className="facts">
              <div>
                <dt>Evidence reference</dt>
                <dd>{latest.evidenceRef ?? 'None recorded'}</dd>
              </div>
              <div>
                <dt>Recorded</dt>
                <dd>
                  {istOrDash(latest.occurredAt)} by {whoWords(latest.actorId, ctx.userId)}
                </dd>
              </div>
              {latest.entriesCounted !== null ? (
                <div>
                  <dt>Verified own accounts counted</dt>
                  <dd>{latest.entriesCounted}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </>
      ) : (
        <>
          <p>
            <strong>Not attested</strong> for key version {state.keyVersion}.
          </p>
          <p>
            Until it is attested: lender accounts cannot be verified or linked, and payments and
            mandates cannot be switched on.
          </p>
        </>
      )}
    </Section>
  );
}

function EventsSection({ state, ctx }: { state: OwnListState; ctx: AccountsContext }) {
  if (state.keyVersion === null) return null;
  return (
    <Section title="Latest events">
      {state.events.length === 0 ? (
        <p>Nothing has been recorded for this key version yet.</p>
      ) : (
        <table>
          <caption>{`Attestations and withdrawals for key version ${String(state.keyVersion)}, newest first`}</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Event</th>
              <th scope="col">By</th>
              <th scope="col">Evidence reference or reason</th>
              <th scope="col">Verified own accounts counted</th>
            </tr>
          </thead>
          <tbody>
            {state.events.map((event) => (
              <tr key={event.id}>
                <th scope="row">{istOrDash(event.occurredAt)}</th>
                <td>{ownListEventWords(event.eventKind)}</td>
                <td>{whoWords(event.actorId, ctx.userId)}</td>
                <td>{event.eventKind === 'attested' ? event.evidenceRef : event.reason}</td>
                <td>{event.entriesCounted ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function ActionsSection({ state, ctx }: { state: OwnListState; ctx: AccountsContext }) {
  const mayAttest = mayAttestOwnList(ctx.caps);
  const mayWithdraw = mayWithdrawOwnList(ctx.caps);
  // Nothing can be attested or withdrawn without an active key version.
  if (state.keyVersion === null) return null;
  return (
    <>
      <Section title="Attest the list">
        {mayAttest ? (
          <PlatformForm op="ownlist.attest" action={ctx.action} returnTo={ctx.returnTo}>
            <p>
              Before you attest: every account of Udofin and its group companies is registered and
              verified, and none is still waiting for verification. The system refuses the statement
              if the list is visibly incomplete. Attesting again with the same evidence changes
              nothing.
            </p>
            <TextField
              name="evidenceRef"
              label="Reference to the evidence"
              required
              hint="Name what the list was reconciled against, for example the title of a document or a review. 3 to 200 characters. Do not type account numbers."
            />
            <AreaField
              name="note"
              label="Note (optional)"
              hint="Up to 1000 characters. Do not type account, phone or identity numbers."
            />
            <CheckInput
              name="confirm"
              required
              label="I have checked the evidence named above, and I am recording the platform’s statement that the list of Udofin and group accounts in the registry is complete."
            />
            <button type="submit">Record the statement</button>
          </PlatformForm>
        ) : (
          <p className="muted">Your role cannot attest the list. That needs the verify right.</p>
        )}
      </Section>
      {state.attested ? (
        <Section title="Withdraw the attestation">
          {mayWithdraw ? (
            <PlatformForm op="ownlist.withdraw" action={ctx.action} returnTo={ctx.returnTo}>
              <p>
                Withdraw the attestation if an account of Udofin or a group company is found that is
                not on the list. From then on, lender accounts cannot be verified or linked, and
                payments and mandates cannot be switched on, until the list is attested again.
                Withdrawing does not itself change any account, link or switch that already exists.
              </p>
              <AreaField
                name="reason"
                label="Reason"
                required
                hint="At least 10 characters. Do not type account, phone or identity numbers."
              />
              <button type="submit" className="secondary">
                Withdraw the attestation
              </button>
            </PlatformForm>
          ) : (
            <p className="muted">Your role cannot withdraw the attestation.</p>
          )}
        </Section>
      ) : null}
    </>
  );
}
