'use client';

import { useState } from 'react';
import { SelectInput, TextArea, TextInput } from '../reminders/fields.js';
import { StatefulForm, typedFirst, type FormRun } from '../reminders/stateful-form.js';
import { RAIL_LIMIT_ROWS, RAIL_VALUE_KINDS, type DraftedConfig } from './types.js';
import { setupErrorMessage } from './wording.js';

// The forms that keep what the person typed when the answer is a refusal, and the one place the callback token is drawn. Each is
// a client component whose props are plain values and one server action, so a server-rendered page can draw it.

export interface Choice {
  value: string;
  label: string;
}

const KIND_WORDS: Readonly<Record<string, string>> = {
  text: 'Text, as written',
  flag: 'Yes or no',
  amount: 'Amount in rupees',
  count: 'Whole number (not an amount)',
};

const MODE_CHOICES: readonly Choice[] = [
  { value: 'production', label: 'Production mode' },
  { value: 'sandbox', label: 'Test only: provider sandbox' },
  { value: 'mock', label: 'Test only: mock provider' },
];

// ---------------------------------------------------------------------------------------------------------------
// The callback token: shown once
// ---------------------------------------------------------------------------------------------------------------
/**
 * The callback path of a draft, which ends in the token that routes the provider's callbacks to this configuration. It is
 * drawn from the form's own memory and nowhere else: it is not in an address, a cookie or any storage, and the person can
 * remove it from the screen. It is not shown again after that or after leaving the page.
 */
export function OneTimeToken({ drafted, clear }: { drafted: DraftedConfig; clear: () => void }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyPath = () => {
    const clipboard = globalThis.navigator?.clipboard;
    if (typeof clipboard?.writeText !== 'function') {
      setCopy('failed');
      return;
    }
    clipboard.writeText(drafted.callbackPath).then(
      () => {
        setCopy('copied');
      },
      () => {
        setCopy('failed');
      },
    );
  };
  return (
    <section className="card" aria-labelledby="one-time-token-title">
      <h3 id="one-time-token-title">Callback path for this draft: shown only once</h3>
      <p>
        <strong>This is shown only once.</strong> Copy it now and set it at your payment provider as
        the place callbacks are sent. The last part of the path is the token. Udofin keeps only a
        one-way fingerprint of it, so it cannot be shown again, and anyone who has it can send
        callbacks to this configuration, so keep it private. If you lose it, withdraw this draft and
        draft a new configuration.
      </p>
      <p>This is the path only. The address of the callback service is not shown on this page.</p>
      <p>
        <code>{drafted.callbackPath}</code>
      </p>
      <p>
        <button type="button" onClick={copyPath}>
          Copy the callback path
        </button>{' '}
        <button type="button" className="secondary" onClick={clear}>
          I have copied it: remove it from this page
        </button>
      </p>
      <p role="status" aria-live="polite">
        {copy === 'copied'
          ? 'Copied.'
          : copy === 'failed'
            ? 'Copying did not work here. Select the path and copy it yourself.'
            : ''}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// A new payment configuration
// ---------------------------------------------------------------------------------------------------------------
export function ConfigDraftForm({
  lenderId,
  action,
  returnTo,
  providers,
  merchants,
  settlementAccounts,
}: {
  lenderId: string;
  action: FormRun<DraftedConfig>;
  returnTo: string;
  providers: readonly Choice[];
  merchants: readonly Choice[];
  settlementAccounts: readonly Choice[];
}) {
  return (
    <StatefulForm<DraftedConfig>
      op="setup.config.draft"
      action={action}
      returnTo={returnTo}
      hidden={{ lenderId }}
      submit="Save as a draft"
      doneMessage="The draft was saved. Its callback path is shown below, once."
      errorMessage={setupErrorMessage}
      renderResult={(drafted, clear) => <OneTimeToken drafted={drafted} clear={clear} />}
      fields={(typed) => (
        <>
          <SelectInput
            name="provider"
            label="Payment provider"
            blank="Choose a provider"
            required
            options={providers}
            defaultValue={typedFirst(typed, 'provider')}
          />
          <SelectInput
            name="providerMode"
            label="Mode"
            blank="Choose a mode"
            required
            options={MODE_CHOICES}
            defaultValue={typedFirst(typed, 'providerMode')}
            hint="A test-only configuration is never a live payment setup. It is refused where test providers are not allowed."
          />
          <SelectInput
            name="merchantRegistryId"
            label="Merchant"
            blank="Choose a merchant"
            required
            options={merchants}
            defaultValue={typedFirst(typed, 'merchantRegistryId')}
            hint="The platform team must have verified the merchant before the configuration can be submitted."
          />
          <SelectInput
            name="settlementAccountId"
            label="Settlement account"
            blank="Choose a settlement account"
            required
            options={settlementAccounts}
            defaultValue={typedFirst(typed, 'settlementAccountId')}
            hint="Only the masked reference is shown. The platform team must have verified and linked the account before the configuration can be submitted."
          />
          <TextInput
            name="secretRef"
            label="Name of the provider secret"
            required
            pattern="[A-Z][A-Z0-9_]{2,63}"
            maxLength={64}
            defaultValue={typedFirst(typed, 'secretRef')}
            hint="The NAME of the secret in your secrets manager: capital letters, digits and underscores, starting with a letter, 3 to 64 characters. Never type the secret itself."
          />
          <TextInput
            name="webhookSecretRef"
            label="Name of the callback signing secret"
            required
            pattern="[A-Z][A-Z0-9_]{2,63}"
            maxLength={64}
            defaultValue={typedFirst(typed, 'webhookSecretRef')}
            hint="The NAME of the secret in your secrets manager, different from the first name. Never type the secret itself."
          />
          <fieldset>
            <legend>Rail limits, copied from your provider’s documentation (optional)</legend>
            <p className="muted">
              Copy each limit exactly as the provider’s documentation states it; none is suggested.
              A limit is a rail (for example the name of a payment method), a limit name, and a
              value. Use lower-case letters, digits and underscores for names. An amount is typed in
              rupees and stored in paise.
            </p>
            {Array.from({ length: RAIL_LIMIT_ROWS }, (_unused, index) => {
              const row = String(index + 1);
              return (
                <fieldset key={row}>
                  <legend>Limit {row}</legend>
                  <TextInput
                    name={`rail${row}`}
                    label="Rail"
                    maxLength={41}
                    defaultValue={typedFirst(typed, `rail${row}`)}
                  />
                  <TextInput
                    name={`limit${row}`}
                    label="Limit name"
                    maxLength={41}
                    defaultValue={typedFirst(typed, `limit${row}`)}
                  />
                  <SelectInput
                    name={`kind${row}`}
                    label="Kind of value"
                    options={RAIL_VALUE_KINDS.map((k) => ({ value: k, label: KIND_WORDS[k] ?? k }))}
                    defaultValue={typedFirst(typed, `kind${row}`) ?? 'text'}
                  />
                  <TextInput
                    name={`value${row}`}
                    label="Value"
                    maxLength={100}
                    defaultValue={typedFirst(typed, `value${row}`)}
                    hint="For a yes or no, type yes or no."
                  />
                </fieldset>
              );
            })}
            <TextArea
              name="railLimitsSource"
              label="Source of the limits (document name and section)"
              rows={2}
              maxLength={500}
              defaultValue={typedFirst(typed, 'railLimitsSource')}
              hint="Required when you give any limit: 10 to 500 characters, no personal details."
            />
          </fieldset>
          <TextInput
            name="evidenceRef"
            label="Provider onboarding confirmation reference (optional now, needed before you submit)"
            maxLength={200}
            defaultValue={typedFirst(typed, 'evidenceRef')}
            hint="A short reference label, not the document itself."
          />
          <TextInput
            name="contractSectionRef"
            label="Contract section reference (optional now, needed before you submit)"
            maxLength={200}
            defaultValue={typedFirst(typed, 'contractSectionRef')}
            hint="A short reference label, for example the section of your agreement."
          />
        </>
      )}
    />
  );
}

// ---------------------------------------------------------------------------------------------------------------
// A settlement account request: masked reference only
// ---------------------------------------------------------------------------------------------------------------
export function SettlementRequestForm({
  lenderId,
  action,
  returnTo,
}: {
  lenderId: string;
  action: FormRun;
  returnTo: string;
}) {
  return (
    <StatefulForm
      op="setup.settlement.request"
      action={action}
      returnTo={returnTo}
      hidden={{ lenderId }}
      submit="Request this settlement account"
      errorMessage={setupErrorMessage}
      fields={(typed) => (
        <>
          <TextInput
            name="label"
            label="A name for the account"
            required
            maxLength={80}
            defaultValue={typedFirst(typed, 'label')}
            hint="2 to 80 characters. Do not put an account number in it."
          />
          <TextInput
            name="bankName"
            label="Bank name"
            required
            maxLength={120}
            defaultValue={typedFirst(typed, 'bankName')}
          />
          <TextInput
            name="maskedRef"
            label="Masked account reference"
            required
            maxLength={24}
            pattern="[X*]{2,}[0-9]{2,4}"
            defaultValue={typedFirst(typed, 'maskedRef')}
            hint="Capital X letters (or *) followed by only the last 2 to 4 digits, for example XXXXXX1234. Never type the full account number: this form does not accept it."
          />
        </>
      )}
    />
  );
}

// ---------------------------------------------------------------------------------------------------------------
// A merchant claim
// ---------------------------------------------------------------------------------------------------------------
export function MerchantClaimForm({
  lenderId,
  action,
  returnTo,
  providers,
}: {
  lenderId: string;
  action: FormRun;
  returnTo: string;
  providers: readonly Choice[];
}) {
  return (
    <StatefulForm
      op="setup.merchant.claim"
      action={action}
      returnTo={returnTo}
      hidden={{ lenderId }}
      submit="Claim this merchant"
      errorMessage={setupErrorMessage}
      fields={(typed) => (
        <>
          <SelectInput
            name="provider"
            label="Payment provider"
            blank="Choose a provider"
            required
            options={providers}
            defaultValue={typedFirst(typed, 'provider')}
          />
          <TextInput
            name="merchantRef"
            label="Merchant identifier at the provider"
            required
            maxLength={100}
            defaultValue={typedFirst(typed, 'merchantRef')}
            hint="The identifier your provider gave your organisation. A claim starts unverified; the platform team verifies it against evidence. An identifier already claimed by anyone else is refused."
          />
        </>
      )}
    />
  );
}
