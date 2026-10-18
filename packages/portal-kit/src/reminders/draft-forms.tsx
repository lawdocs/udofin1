'use client';

import {
  LR_CHARGE_KINDS,
  LR_HOLD_REASONS,
  LR_PENAL_TEXT_VARIABLE,
  LR_REMINDER_KINDS,
  LR_TEMPLATE_LANGUAGES,
  LR_TEMPLATE_VARIABLES,
} from '@udofin/contracts';
import { CheckInput, Group, SelectInput, TextArea, TextInput } from './fields.js';
import { StatefulForm, typedFirst, typedHas, type FormRun } from './stateful-form.js';
import {
  channelWords,
  chargeKindWords,
  holdReasonWords,
  languageWords,
  reminderKindWords,
  remindersErrorMessage,
} from './wording.js';

// The forms that keep what the person typed when the answer is a refusal. Each is a client component whose props are plain
// values and one server action, so a server-rendered page can draw it (a function cannot cross from a server component into
// a client component, so the controls are defined here, next to the form that runs them).

const options = (values: readonly string[], words: (value: string) => string) =>
  values.map((value) => ({ value, label: words(value) }));

interface DraftFormProps {
  lenderId: string;
  action: FormRun;
  returnTo: string;
}

export function PolicyDraftFields({ lenderId, action, returnTo }: DraftFormProps) {
  return (
    <StatefulForm
      op="reminders.policy.draft"
      action={action}
      returnTo={returnTo}
      hidden={{ lenderId }}
      submit="Save as a draft"
      errorMessage={remindersErrorMessage}
      fields={(typed) => (
        <>
          <TextInput
            name="offsets"
            label="Days from each due date"
            defaultValue={typedFirst(typed, 'offsets')}
            required
            hint="Whole numbers separated by commas. A negative number is days before the due date, 0 is the due date and a positive number is days after."
          />
          <Group legend="Channels">
            <CheckInput
              name="channels"
              value="in_app"
              label={channelWords('in_app')}
              checked={typedHas(typed, 'channels', 'in_app')}
            />
            <CheckInput
              name="channels"
              value="push"
              label={channelWords('push')}
              checked={typedHas(typed, 'channels', 'push')}
            />
            <p className="muted">{channelWords('sms')}.</p>
          </Group>
          <CheckInput
            name="overdueWeekly"
            label="Also send weekly overdue reminders"
            checked={typedHas(typed, 'overdueWeekly')}
          />
          <TextInput
            name="windowFrom"
            label="Daily window starts (India time)"
            type="time"
            defaultValue={typedFirst(typed, 'windowFrom')}
            required
          />
          <TextInput
            name="windowTo"
            label="Daily window ends (India time)"
            type="time"
            defaultValue={typedFirst(typed, 'windowTo')}
            required
            hint="The platform can only narrow the window. If a value is not accepted, the form says so and keeps what you typed."
          />
          <TextInput
            name="maxPerDay"
            label="Most messages per loan per day"
            type="number"
            inputMode="numeric"
            defaultValue={typedFirst(typed, 'maxPerDay')}
            required
            hint="The platform can only lower the cap."
          />
        </>
      )}
    />
  );
}

export function TemplateDraftFields({ lenderId, action, returnTo }: DraftFormProps) {
  return (
    <>
      <p>
        The wording is yours: write it yourself. Udofin does not suggest, generate or translate
        wording and sends it exactly as approved. It must be a plain service message. You may use
        only these placeholders:{' '}
        {LR_TEMPLATE_VARIABLES.map((name, index) => (
          <span key={name}>
            {index > 0 ? ', ' : ''}
            <code>{`{{${name}}}`}</code>
          </span>
        ))}
        . Wording for an overdue reminder must contain <code>{LR_PENAL_TEXT_VARIABLE}</code>; the
        approved penal-charge sentence is placed there exactly as approved. Hindi wording is checked
        only for its shape, not its meaning, so the person who approves it should read Hindi.
      </p>
      <StatefulForm
        op="reminders.template.draft"
        action={action}
        returnTo={returnTo}
        hidden={{ lenderId }}
        submit="Save as a draft"
        errorMessage={remindersErrorMessage}
        fields={(typed) => (
          <>
            <SelectInput
              name="kind"
              label="Kind of reminder"
              blank="Choose a kind"
              required
              options={options(LR_REMINDER_KINDS, reminderKindWords)}
              defaultValue={typedFirst(typed, 'kind')}
            />
            <SelectInput
              name="language"
              label="Language"
              blank="Choose a language"
              required
              options={options(LR_TEMPLATE_LANGUAGES, languageWords)}
              defaultValue={typedFirst(typed, 'language')}
            />
            <TextArea
              name="body"
              label="Wording"
              required
              maxLength={4000}
              rows={6}
              defaultValue={typedFirst(typed, 'body')}
              hint="At most 4,000 characters. No link, address, phone number, long run of digits or promotional words."
            />
          </>
        )}
      />
    </>
  );
}

export function PenalDraftFields({ lenderId, action, returnTo }: DraftFormProps) {
  return (
    <StatefulForm
      op="reminders.penal.draft"
      action={action}
      returnTo={returnTo}
      hidden={{ lenderId }}
      submit="Save as a draft"
      errorMessage={remindersErrorMessage}
      fields={(typed) => (
        <>
          <SelectInput
            name="chargeKind"
            label="Kind of charge"
            blank="Choose a kind"
            required
            options={options(LR_CHARGE_KINDS, chargeKindWords)}
            defaultValue={typedFirst(typed, 'chargeKind')}
            hint="The charge is on the overdue amount only."
          />
          <TextInput
            name="flatAmount"
            label="Flat amount in rupees (for a flat charge)"
            inputMode="decimal"
            defaultValue={typedFirst(typed, 'flatAmount')}
            hint="Digits only, with at most two decimals, for example 250 or 250.50."
          />
          <TextInput
            name="percent"
            label="Percentage of the overdue amount (for a percentage charge)"
            inputMode="decimal"
            defaultValue={typedFirst(typed, 'percent')}
            hint="Digits only, with at most two decimals, for example 2 or 2.5. Give either the amount or the percentage, not both."
          />
          <TextArea
            name="reason"
            label="Reason for the charge"
            required
            maxLength={2000}
            rows={3}
            defaultValue={typedFirst(typed, 'reason')}
          />
          <TextArea
            name="sentenceEn"
            label="Sentence shown to the borrower, in English"
            required
            maxLength={4000}
            rows={4}
            defaultValue={typedFirst(typed, 'sentenceEn')}
          />
          <TextArea
            name="sentenceHi"
            label="Sentence shown to the borrower, in Hindi (optional)"
            maxLength={4000}
            rows={4}
            defaultValue={typedFirst(typed, 'sentenceHi')}
            hint="Hindi is checked only for its shape, not its meaning, so the person who approves it should read Hindi."
          />
          <Group legend="Statements by your organisation (both are required)">
            <CheckInput
              name="separateFromInterest"
              label="Our organisation states that this charge is charged separately from interest."
              required
            />
            <CheckInput
              name="notCompounded"
              label="Our organisation states that this charge is not compounded."
              required
            />
          </Group>
        </>
      )}
    />
  );
}

export function HoldPlaceFields({ action, returnTo }: Omit<DraftFormProps, 'lenderId'>) {
  return (
    <StatefulForm
      op="reminders.hold.place"
      action={action}
      returnTo={returnTo}
      submit="Place the hold"
      errorMessage={remindersErrorMessage}
      fields={(typed) => (
        <>
          <TextInput
            name="loanAccountId"
            label="Loan ID"
            required
            defaultValue={typedFirst(typed, 'loanAccountId')}
            hint="The ID in the address of the loan’s page under Loans."
          />
          <SelectInput
            name="reason"
            label="Reason"
            blank="Choose a reason"
            required
            options={options(LR_HOLD_REASONS, holdReasonWords)}
            defaultValue={typedFirst(typed, 'reason')}
          />
          <TextArea
            name="note"
            label="Note (optional)"
            rows={3}
            maxLength={1000}
            defaultValue={typedFirst(typed, 'note')}
            hint="Do not write names, phone numbers, account numbers or other personal details."
          />
        </>
      )}
    />
  );
}
