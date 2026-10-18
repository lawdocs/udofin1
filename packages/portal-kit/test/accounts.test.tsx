// @vitest-environment jsdom
// The operations screens for providers, the account registry, feature switches and platform exceptions: every state (empty,
// failed, each status), the wording rules, the guards that hide a write form from a role that may not use it or from the person
// who did the first step, the two switches that can never be enabled, and above all that an account number is never drawn,
// echoed or kept by any screen.
import { cleanup, render, screen, within } from '@testing-library/react';
import { type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import * as kit from '../src/index.js';
import { ExceptionDetailPage, ExceptionsPage } from '../src/accounts/exception-views.js';
import { FeaturesPage } from '../src/accounts/feature-views.js';
import { MerchantsPage, SettlementPage } from '../src/accounts/merchant-views.js';
import { ProvidersPage } from '../src/accounts/provider-views.js';
import { RegistryPage, RulesPage, registrationReadiness } from '../src/accounts/registry-views.js';
import { type LenderChoice } from '../src/accounts/types.js';
import {
  ALL_PERMISSIONS,
  approvedRule,
  CANARY_ACCOUNT,
  CANARY_BRANCH_CODE,
  CANARY_LAST_FOUR,
  CATALOGUE,
  catalogueEntry,
  changeRequest,
  contextFor,
  EXCEPTION_1,
  EXCEPTION_2,
  exceptionDetail,
  fail,
  feeMerchant,
  keyVersion,
  LENDER_A,
  LENDER_B,
  list,
  merchant,
  ME,
  OTHER,
  ok,
  page,
  platformException,
  provider,
  REGISTRY_1,
  REGISTRY_2,
  REGISTRY_3,
  registryEntry,
  returnCode,
  rule,
  RULE_2,
  settlement,
  switchState,
} from './accounts-fixtures.js';

afterEach(cleanup);

const text = (container: HTMLElement) => container.textContent ?? '';
const ops = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLInputElement>('input[name="op"]')].map((i) => i.value);
const hiddenIn = (form: Element, name: string) =>
  form.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`)?.value;
const formsWith = (container: HTMLElement, op: string) =>
  [...container.querySelectorAll('form')].filter((f) => hiddenIn(f, 'op') === op);
const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const NONE = {};
const FINANCE: LenderChoice[] = [
  { id: LENDER_A, name: 'Sample Finance' },
  { id: LENDER_B, name: 'Other Credit' },
];

const full = (returnTo = '/accounts') => contextFor(ALL_PERMISSIONS, returnTo);
const asVerifier = (returnTo = '/accounts') =>
  contextFor(['platform.accounts.registry.verify'], returnTo);
const asManager = (returnTo = '/accounts') =>
  contextFor(['platform.accounts.registry.manage'], returnTo);
const nobody = (returnTo = '/accounts') => contextFor([], returnTo);

// ---- reused pages ----------------------------------------------------------------------------------------------------
const READY_RULES = list([approvedRule()]);
const ACTIVE_KEYS = list([keyVersion()]);

const registry = (over: Partial<Parameters<typeof RegistryPage>[0]> = {}): ReactElement => (
  <RegistryPage
    accounts={page([registryEntry()])}
    registered={null}
    rules={READY_RULES}
    keys={ACTIVE_KEYS}
    lenders={FINANCE}
    query={{}}
    ctx={full()}
    notice={NONE}
    {...over}
  />
);

// =====================================================================================================================
describe('Providers', () => {
  const view = (over: Partial<Parameters<typeof ProvidersPage>[0]> = {}) =>
    render(
      <ProvidersPage
        providers={list([provider()])}
        returnCodes={list([returnCode()])}
        ctx={full('/providers')}
        notice={NONE}
        {...over}
      />,
    );

  it('says plainly that no provider has been chosen when the register is empty', () => {
    view({ providers: list([]), returnCodes: list([]) });
    expect(screen.getByText('No providers')).toBeTruthy();
    expect(screen.getByText('No return codes')).toBeTruthy();
    expect(text(document.body)).toContain('Nothing is filled in for you');
  });

  it('writes a provider in plain words and calls the evidence label what staff recorded', () => {
    const { container } = view();
    const t = text(container);
    expect(t).toContain('Sample Pay (test only)');
    expect(t).toContain('Payments and mandates');
    expect(t).toContain('Approved by staff');
    expect(t).toContain('Likely: not confirmed against a source');
    expect(t).toContain('Sample provider letter 1');
    expect(t).toContain('it is not a statement by Udofin that a provider is authorised');
  });

  it('says there is no evidence reference rather than leaving a blank, and marks unverified evidence', () => {
    const { container } = view({
      providers: list([provider({ authorisationEvidenceRef: null, evidenceLabel: 'unverified' })]),
    });
    expect(text(container)).toContain('No reference recorded');
    expect(text(container)).toContain('Unverified: no source has been supplied');
  });

  it('shows a suspended provider with the reason that was recorded', () => {
    const { container } = view({
      providers: list([provider({ status: 'suspended', statusReason: 'Paused by the provider' })]),
    });
    expect(text(container)).toContain('Suspended');
    expect(text(container)).toContain('Paused by the provider');
  });

  it('shows a load failure without repeating what the server said', () => {
    const { container } = view({
      providers: fail(500, 'upstream_internal_detail'),
      returnCodes: fail(500, 'upstream_internal_detail'),
    });
    expect(text(container)).toContain('Could not load the provider register');
    expect(text(container)).not.toContain('upstream_internal_detail');
    cleanup();
    const denied = view({ providers: fail(403, 'forbidden') });
    expect(text(denied.container)).toContain('You cannot view the provider register');
  });

  it('lists return codes with the class staff set and the source reference', () => {
    const { container } = view();
    const table = within(container).getByRole('table', { hidden: true });
    expect(text(table)).toContain('R01');
    expect(text(table)).toContain('Insufficient funds');
    expect(text(table)).toContain('Sample return-code sheet');
  });

  it('offers the write forms to a person who may manage providers, with nothing pre-filled in the new-provider form', () => {
    const { container } = view();
    expect(new Set(ops(container))).toEqual(new Set(['provider.set', 'returncode.set']));
    const add = formsWith(container, 'provider.set').find((f) =>
      text(f).includes('Add the provider'),
    );
    expect(add).toBeTruthy();
    for (const name of ['kind', 'status', 'evidenceLabel'])
      expect(add?.querySelector<HTMLSelectElement>(`select[name="${name}"]`)?.value).toBe('');
    expect(add?.querySelector<HTMLInputElement>('input[name="provider"]')?.value).toBe('');
    const codeForm = formsWith(container, 'returncode.set')[0];
    expect(codeForm?.querySelector<HTMLSelectElement>('select[name="class"]')?.value).toBe('');
    expect(codeForm?.querySelector<HTMLInputElement>('input[name="code"]')?.value).toBe('');
  });

  it('asks for a reason when a provider is suspended', () => {
    const { container } = view();
    expect(text(container)).toContain('Required when you suspend a provider');
  });

  it('shows no write form to a role without the permission', () => {
    const { container } = view({ ctx: nobody('/providers') });
    expect(ops(container)).toEqual([]);
    expect(container.querySelectorAll('form[action]:not([method="get"])')).toHaveLength(0);
    expect(text(container)).toContain('Your role cannot change the register.');
    // The registry permissions do not open the provider forms either.
    const registryOnly = view({
      ctx: contextFor(['platform.accounts.registry.manage'], '/providers'),
    });
    expect(ops(registryOnly.container)).toEqual([]);
  });

  it('types a provider key when the register could not be read', () => {
    const { container } = view({ providers: fail(500, 'x') });
    const codeForm = formsWith(container, 'returncode.set')[0];
    expect(codeForm?.querySelector('input[name="provider"]')).toBeTruthy();
    expect(codeForm?.querySelector('select[name="provider"]')).toBeNull();
  });
});

// =====================================================================================================================
describe('Registering an account', () => {
  describe('when it is offered at all', () => {
    it('is offered only with an approved format rule and an active key version', () => {
      const ready = registrationReadiness(READY_RULES, ACTIVE_KEYS);
      expect(ready).toMatchObject({
        ready: true,
        missing: [],
        formats: [{ country: 'IN', accountType: 'bank_account' }],
        activeVersion: 1,
        proposedVersion: null,
      });
    });

    it('is not offered while the only rule is the unapproved seed', () => {
      const r = registrationReadiness(list([rule()]), ACTIVE_KEYS);
      expect(r.ready).toBe(false);
      expect(r.formats).toEqual([]);
      expect(r.missing.join(' ')).toMatch(/No account format rule is approved yet/);
    });

    it('is not offered without an active key version (a proposed one does not count)', () => {
      const r = registrationReadiness(
        READY_RULES,
        list([keyVersion({ status: 'proposed', approvedBy: null, approvedAt: null })]),
      );
      expect(r.ready).toBe(false);
      expect(r.proposedVersion).toBe(1);
      expect(r.activeVersion).toBeNull();
      expect(r.missing.join(' ')).toMatch(/No fingerprint key version is active/);
    });

    it('is not offered when either fact could not be read', () => {
      expect(registrationReadiness(fail(500, 'x'), ACTIVE_KEYS).ready).toBe(false);
      expect(registrationReadiness(READY_RULES, fail(500, 'x')).ready).toBe(false);
      expect(registrationReadiness(fail(500, 'x'), fail(500, 'x')).missing).toHaveLength(2);
    });

    it('shows the reason instead of a form that could not succeed', () => {
      const { container } = render(registry({ rules: list([rule()]) }));
      expect(container.querySelector('input[type="password"]')).toBeNull();
      expect(text(container)).toContain('No account format rule is approved yet');
      cleanup();
      const noKey = render(registry({ keys: list([]) }));
      expect(noKey.container.querySelector('input[type="password"]')).toBeNull();
      expect(text(noKey.container)).toContain('No fingerprint key version is active');
    });

    it('is not offered to a role without the registry manage permission', () => {
      for (const ctx of [asVerifier(), nobody(), contextFor(['platform.features.manage'])]) {
        const { container } = render(registry({ ctx }));
        expect(
          container.querySelector('input[type="password"]'),
          JSON.stringify(ctx.caps),
        ).toBeNull();
        expect(text(container)).toContain('Your role cannot register accounts.');
        cleanup();
      }
    });
  });

  describe('the form', () => {
    const formOfNumber = (container: HTMLElement) =>
      container.querySelector('input[name="accountNumber"]')?.closest('form') ?? null;

    it('has one password-type field for the number, with no autofill, no spell check and no value', () => {
      const { container } = render(registry());
      const fields = container.querySelectorAll<HTMLInputElement>('input[name="accountNumber"]');
      expect(fields).toHaveLength(1);
      const field = fields[0];
      expect(field?.type).toBe('password');
      expect(field?.getAttribute('autocomplete')).toBe('off');
      expect(field?.getAttribute('inputmode')).toBe('numeric');
      expect(field?.getAttribute('spellcheck')).toBe('false');
      expect(field?.required).toBe(true);
      expect(field?.hasAttribute('value')).toBe(false);
      expect(field?.value).toBe('');
      expect(formOfNumber(container)?.getAttribute('autocomplete')).toBe('off');
      // Typed once: there is no second copy of the number to confirm against.
      expect(container.querySelectorAll('input[type="password"]')).toHaveLength(2);
    });

    it('posts to the registration entry point only: the form names no operation and cannot be routed through the general one', () => {
      const ctx = full();
      const { container } = render(registry({ ctx }));
      const form = formOfNumber(container);
      expect(form).toBeTruthy();
      expect(form?.querySelector('input[name="op"]')).toBeNull();
      expect(form?.querySelector('input[name="returnTo"]')).toBeNull();
      expect(form?.querySelector('input[name="key"]')).toBeTruthy();
      // And no form that names an operation holds a password field.
      for (const f of container.querySelectorAll('form')) {
        if (hiddenIn(f, 'op')) expect(f.querySelector('input[type="password"]')).toBeNull();
      }
    });

    it('draws the owner, purposes and dates blank: nothing is chosen for the person', () => {
      const { container } = render(registry());
      const form = formOfNumber(container);
      expect(form?.querySelector<HTMLSelectElement>('select[name="ownerKind"]')?.value).toBe('');
      expect(form?.querySelector<HTMLSelectElement>('select[name="ownerOrgId"]')?.value).toBe('');
      const purposes = form?.querySelectorAll<HTMLInputElement>('input[name="permittedPurposes"]');
      expect(purposes).toHaveLength(4);
      for (const box of purposes ?? []) expect(box.checked).toBe(false);
      expect(form?.querySelector<HTMLInputElement>('input[name="legalOwnerName"]')?.value).toBe('');
      expect(form?.querySelector<HTMLInputElement>('input[name="effectiveFrom"]')?.value).toBe('');
    });

    it('takes the format only from the approved rules', () => {
      const { container } = render(
        registry({
          rules: list([
            approvedRule(),
            approvedRule({ id: RULE_2, country: 'IN', accountType: 'current_account', version: 2 }),
            rule({ id: REGISTRY_3, country: 'XX' }),
          ]),
        }),
      );
      const form = formOfNumber(container);
      const countries = [...(form?.querySelectorAll('select[name="country"] option') ?? [])].map(
        (o) => (o as HTMLOptionElement).value,
      );
      expect(countries).toEqual(['IN']);
      const types = [...(form?.querySelectorAll('select[name="accountType"] option') ?? [])].map(
        (o) => (o as HTMLOptionElement).value,
      );
      expect(types).toEqual(['', 'bank_account', 'current_account']);
    });

    it('types the lender’s identifier when the list of lenders could not be read', () => {
      const { container } = render(registry({ lenders: null }));
      const form = formOfNumber(container);
      expect(form?.querySelector('select[name="ownerOrgId"]')).toBeNull();
      expect(form?.querySelector('input[name="ownerOrgId"]')).toBeTruthy();
    });
  });

  describe('after a submit', () => {
    it('shows only the masked reference the API returned, and its status, never the number', () => {
      const entry = registryEntry();
      const { container } = render(registry({ registered: ok(entry) }));
      expect(text(container)).toContain(
        `The account was registered with the reference XXXXXX${CANARY_LAST_FOUR}`,
      );
      expect(text(container)).toContain('Unverified: waiting for a different person to verify it');
      expect(container.innerHTML).not.toContain(CANARY_ACCOUNT);
      expect(container.innerHTML).not.toContain(CANARY_BRANCH_CODE);
    });

    it('says the account was registered even when the entry cannot be read back, and shows nothing else', () => {
      const { container } = render(registry({ registered: fail(500, 'upstream_internal_detail') }));
      expect(text(container)).toContain(
        'The account was registered, but the entry could not be read back',
      );
      expect(text(container)).not.toContain('upstream_internal_detail');
    });

    it('draws no value into any field, in the success state, in each refusal and after a failed load', () => {
      const states: Partial<Parameters<typeof RegistryPage>[0]>[] = [
        { registered: ok(registryEntry()), notice: { done: true } },
        { notice: { error: 'account_number_invalid' } },
        { notice: { error: 'ifsc_invalid' } },
        { notice: { error: 'account_already_registered' } },
        { notice: { error: 'key_management_unavailable' } },
        { notice: { error: 'account_format_unvalidated' } },
        { notice: { error: 'network_error' } },
        { notice: { error: 'unknown' } },
        { accounts: fail(500, 'x') },
        { accounts: page([]) },
      ];
      for (const state of states) {
        const { container } = render(registry(state));
        // The number field and the IFSC field are empty and have no value attribute.
        for (const field of container.querySelectorAll<HTMLInputElement>(
          'input[type="password"]',
        )) {
          expect(field.value).toBe('');
          expect(field.hasAttribute('value')).toBe(false);
        }
        expect(container.innerHTML).not.toContain(CANARY_ACCOUNT);
        expect(container.innerHTML).not.toContain(CANARY_BRANCH_CODE);
        cleanup();
      }
    });

    it('shows a refusal in fixed words, never a number, and never what a server might write', () => {
      const { container } = render(registry({ notice: { error: 'account_number_invalid' } }));
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('The account number was not accepted');
      expect(alert?.textContent).toContain('Nothing was stored');
      cleanup();
      const unavailable = render(registry({ notice: { error: 'key_management_unavailable' } }));
      expect(text(unavailable.container)).toContain(
        'Registering an account is not available here yet',
      );
    });

    it('holds no run of nine or more digits anywhere in the page (identifiers set aside)', () => {
      const states = [
        registry({ registered: ok(registryEntry()) }),
        registry({
          accounts: page([
            registryEntry(),
            registryEntry({
              id: REGISTRY_2,
              ownerKind: 'udofin',
              ownerOrgId: null,
              permittedPurposes: ['fee_collection'],
            }),
          ]),
        }),
      ];
      for (const element of states) {
        const { container } = render(element);
        const runs = container.innerHTML.replace(UUIDS, '').match(/[0-9]{9,}/g);
        expect(runs).toBeNull();
        cleanup();
      }
    });
  });
});

// =====================================================================================================================
describe('Registered accounts', () => {
  it('says plainly when there are none, and when the list cannot be read', () => {
    render(registry({ accounts: page([]) }));
    expect(screen.getByText('No registered accounts')).toBeTruthy();
    cleanup();
    const { container } = render(registry({ accounts: fail(403, 'forbidden') }));
    expect(text(container)).toContain('You cannot view the registered accounts');
    cleanup();
    const failed = render(registry({ accounts: fail(500, 'upstream_internal_detail') }));
    expect(text(failed.container)).toContain('Could not load the registered accounts');
    expect(text(failed.container)).not.toContain('upstream_internal_detail');
  });

  it('shows the masked reference, the owner by name, the purposes, the dates and the status', () => {
    const { container } = render(
      registry({ accounts: page([registryEntry({ effectiveTo: '2027-10-01' })]) }),
    );
    const t = text(container);
    expect(t).toContain(`Account XXXXXX${CANARY_LAST_FOUR}`);
    expect(t).toContain('A lender: Sample Finance');
    expect(t).toContain('Sample Finance Ltd');
    expect(t).toContain('Repayment settlement');
    expect(t).toContain('From 1 Oct 2026, until 1 Oct 2027 (that day is not included)');
    expect(t).toContain('Unverified: waiting for a different person to verify it');
    expect(t).toContain('fingerprint key version 1');
    expect(t).toContain('Registered');
    expect(t).toContain('by another member of staff');
  });

  it('identifies Udofin’s own and group accounts in words', () => {
    const { container } = render(
      registry({
        accounts: page([
          registryEntry({
            id: REGISTRY_2,
            ownerKind: 'udofin',
            ownerOrgId: null,
            permittedPurposes: ['fee_collection'],
          }),
          registryEntry({
            id: REGISTRY_3,
            ownerKind: 'group_company',
            ownerOrgId: null,
            permittedPurposes: ['operational'],
          }),
        ]),
      }),
    );
    const t = text(container);
    expect(t).toContain('Udofin’s own account: this is not a lender’s account.');
    expect(t).toContain('A group company’s account: this is not a lender’s account.');
    expect(t).toContain('Fee collection');
  });

  it('uses the identifier when the lender’s name is not available, and no ownership claim beyond the API’s', () => {
    const { container } = render(registry({ lenders: null }));
    expect(text(container)).toContain(`Lender ${LENDER_A}`);
  });

  it('words each status, and shows the reason of a rejection and a revocation', () => {
    const { container } = render(
      registry({
        accounts: page([
          registryEntry({
            id: REGISTRY_1,
            verificationStatus: 'verified',
            verifiedBy: OTHER,
            verifiedAt: '2026-10-18T10:00:00+05:30',
            evidenceRef: 'Sample bank letter 3',
          }),
          registryEntry({
            id: REGISTRY_2,
            verificationStatus: 'rejected',
            rejectedAt: '2026-10-18T10:00:00+05:30',
            rejectionReason: 'Entered for the wrong owner',
          }),
          registryEntry({
            id: REGISTRY_3,
            verificationStatus: 'revoked',
            revokedAt: '2026-10-18T10:00:00+05:30',
            revokedReason: 'Bank closed the account',
          }),
        ]),
      }),
    );
    const t = text(container);
    expect(t).toContain('Verified');
    expect(t).toContain('evidence: Sample bank letter 3');
    expect(t).toContain('Rejected');
    expect(t).toContain('Entered for the wrong owner');
    expect(t).toContain('Revoked');
    expect(t).toContain('Bank closed the account');
  });

  describe('verifying needs a different person than the registrant', () => {
    it('offers the verify form to a verifier who did not register the entry', () => {
      const { container } = render(
        registry({ accounts: page([registryEntry({ registeredBy: OTHER })]) }),
      );
      const form = formsWith(container, 'account.verify')[0];
      expect(form).toBeTruthy();
      expect(hiddenIn(form as Element, 'id')).toBe(REGISTRY_1);
      expect(form?.querySelector('input[name="evidenceRef"]')).toBeTruthy();
    });

    it('does not offer it to the person who registered the entry, and says why', () => {
      const { container } = render(
        registry({ accounts: page([registryEntry({ registeredBy: ME })]) }),
      );
      expect(formsWith(container, 'account.verify')).toHaveLength(0);
      expect(text(container)).toContain(
        'You registered this account, so a different person must verify it.',
      );
    });

    it('does not offer it to a role without the verify permission', () => {
      const { container } = render(
        registry({ ctx: asManager(), accounts: page([registryEntry({ registeredBy: OTHER })]) }),
      );
      expect(formsWith(container, 'account.verify')).toHaveLength(0);
      expect(text(container)).toContain('Your role cannot verify accounts.');
    });

    it('does not offer it for an entry that is no longer waiting', () => {
      for (const verificationStatus of ['verified', 'rejected', 'revoked']) {
        const { container } = render(
          registry({
            accounts: page([registryEntry({ verificationStatus, registeredBy: OTHER })]),
          }),
        );
        expect(formsWith(container, 'account.verify'), verificationStatus).toHaveLength(0);
        cleanup();
      }
    });
  });

  describe('reject and revoke', () => {
    it('offers reject for an entry that waits, and revoke for one that waits or is verified, each with a required reason', () => {
      const { container } = render(
        registry({
          accounts: page([
            registryEntry({ id: REGISTRY_1 }),
            registryEntry({
              id: REGISTRY_2,
              verificationStatus: 'verified',
              verifiedBy: OTHER,
              verifiedAt: '2026-10-18T10:00:00+05:30',
              evidenceRef: 'Sample bank letter 3',
            }),
          ]),
        }),
      );
      expect(formsWith(container, 'account.reject').map((f) => hiddenIn(f, 'id'))).toEqual([
        REGISTRY_1,
      ]);
      expect(formsWith(container, 'account.revoke').map((f) => hiddenIn(f, 'id'))).toEqual([
        REGISTRY_1,
        REGISTRY_2,
      ]);
      for (const form of [
        ...formsWith(container, 'account.reject'),
        ...formsWith(container, 'account.revoke'),
      ]) {
        const reason = form.querySelector<HTMLTextAreaElement>('textarea[name="reason"]');
        expect(reason?.required).toBe(true);
        expect(form.textContent).toContain('At least 10 characters');
      }
      expect(text(container)).toContain(
        'Revoking also revokes the lender settlement accounts linked to this entry',
      );
    });

    it('offers nothing for an entry that is already rejected or revoked', () => {
      for (const verificationStatus of ['rejected', 'revoked']) {
        const { container } = render(
          registry({ accounts: page([registryEntry({ verificationStatus })]) }),
        );
        expect(
          ops(container).filter((o) => o.startsWith('account.')),
          verificationStatus,
        ).toEqual([]);
        cleanup();
      }
    });

    it('offers reject and revoke to either registry role, and to nobody else', () => {
      for (const ctx of [asManager(), asVerifier()]) {
        const { container } = render(registry({ ctx }));
        expect(formsWith(container, 'account.reject')).toHaveLength(1);
        expect(formsWith(container, 'account.revoke')).toHaveLength(1);
        cleanup();
      }
      const { container } = render(
        registry({ ctx: contextFor(['platform.payments.providers.manage']) }),
      );
      expect(ops(container).filter((o) => o.startsWith('account.'))).toEqual([]);
    });
  });

  describe('re-registering for a key rotation', () => {
    const proposed = list([
      keyVersion(),
      keyVersion({ keyVersion: 2, status: 'proposed', approvedBy: null, approvedAt: null }),
    ]);

    it('offers it, for an entry under the active version, only while a version is proposed', () => {
      const { container } = render(registry({ keys: proposed }));
      expect(text(container)).toContain('Re-register under key version 2');
      const form = container.querySelector('input[name="rekeysRegistryId"]')?.closest('form');
      expect(form?.querySelector('input[name="op"]')).toBeNull();
      expect(form?.querySelectorAll('input[type="password"]')).toHaveLength(2);
      for (const field of form?.querySelectorAll<HTMLInputElement>('input[type="password"]') ?? [])
        expect(field.hasAttribute('value')).toBe(false);
      expect(
        (form?.querySelector('input[name="rekeysRegistryId"]') as HTMLInputElement).value,
      ).toBe(REGISTRY_1);
      cleanup();
      const none = render(registry());
      expect(none.container.querySelector('input[name="rekeysRegistryId"]')).toBeNull();
    });

    it('does not offer it to a role that cannot register, or for an entry that is gone', () => {
      const verifier = render(registry({ keys: proposed, ctx: asVerifier() }));
      expect(verifier.container.querySelector('input[name="rekeysRegistryId"]')).toBeNull();
      cleanup();
      const revoked = render(
        registry({
          keys: proposed,
          accounts: page([registryEntry({ verificationStatus: 'revoked' })]),
        }),
      );
      expect(revoked.container.querySelector('input[name="rekeysRegistryId"]')).toBeNull();
    });
  });

  it('pages with older-links that keep the filters', () => {
    const { container } = render(
      registry({
        accounts: page([registryEntry()], 'next_cursor_1'),
        query: { status: 'unverified' },
      }),
    );
    const link = [...container.querySelectorAll('a')].find(
      (a) => a.textContent === 'Older accounts',
    );
    expect(link?.getAttribute('href')).toBe('/accounts?status=unverified&cursor=next_cursor_1');
  });
});

// =====================================================================================================================
describe('Format rules and key versions', () => {
  const rulesPage = (over: Partial<Parameters<typeof RulesPage>[0]> = {}) =>
    render(
      <RulesPage
        rules={list([rule()])}
        keys={list([])}
        query={{}}
        ctx={full('/accounts/rules')}
        notice={NONE}
        {...over}
      />,
    );

  it('shows the seeded rule as an unverified assumption with its length marked unverified', () => {
    const { container } = rulesPage();
    const t = text(container);
    expect(t).toContain('IN, bank account, version 1');
    expect(t).toContain('Draft: not in use');
    expect(t).toContain('Unverified: no source has been supplied');
    expect(t).toContain('initial assumption, no source on file');
    expect(t).toContain('9 to 18 digits, as recorded in this rule (unverified)');
  });

  it('says an approved rule with an unverified label is a decision, not evidence', () => {
    const { container } = rulesPage({ rules: list([approvedRule()]) });
    expect(text(container)).toContain('a recorded decision, not evidence');
    cleanup();
    const sourced = rulesPage({ rules: list([approvedRule({ evidenceLabel: 'confirmed' })]) });
    expect(text(sourced.container)).not.toContain('a recorded decision, not evidence');
    expect(text(sourced.container)).toContain('Marked confirmed by staff against a source');
  });

  it('offers to propose the seeded draft to a manager, and not to a verifier', () => {
    const manager = rulesPage({ ctx: asManager('/accounts/rules') });
    expect(formsWith(manager.container, 'rule.submit')).toHaveLength(1);
    cleanup();
    const verifier = rulesPage({ ctx: asVerifier('/accounts/rules') });
    expect(formsWith(verifier.container, 'rule.submit')).toHaveLength(0);
    expect(text(verifier.container)).toContain('Your role cannot propose rules.');
  });

  describe('approving needs a different person than the drafter and the proposer', () => {
    const proposedRule = (over: object = {}) =>
      rule({ draftedBy: OTHER, submittedBy: OTHER, ...over });

    it('offers approval to a verifier who did neither', () => {
      const { container } = rulesPage({
        rules: list([proposedRule()]),
        ctx: asVerifier('/accounts/rules'),
      });
      expect(formsWith(container, 'rule.approve')).toHaveLength(1);
    });

    it('does not offer it to the drafter, nor to the proposer, and says why', () => {
      for (const over of [{ draftedBy: ME }, { submittedBy: ME }]) {
        const { container } = rulesPage({
          rules: list([proposedRule(over)]),
          ctx: asVerifier('/accounts/rules'),
        });
        expect(formsWith(container, 'rule.approve'), JSON.stringify(over)).toHaveLength(0);
        expect(text(container)).toContain('so a different person must approve it');
        cleanup();
      }
    });

    it('does not offer it to a role without the verify permission', () => {
      const { container } = rulesPage({
        rules: list([proposedRule()]),
        ctx: asManager('/accounts/rules'),
      });
      expect(formsWith(container, 'rule.approve')).toHaveLength(0);
      expect(text(container)).toContain('Waiting for a different person to approve it.');
    });
  });

  it('offers retirement, with a required reason, to either registry role and only for a rule in use or waiting', () => {
    const { container } = rulesPage({
      rules: list([
        rule({ draftedBy: OTHER, submittedBy: OTHER }),
        approvedRule({ id: RULE_2 }),
        rule({
          id: REGISTRY_3,
          status: 'retired',
          retiredAt: '2026-10-18T10:00:00+05:30',
          retiredReason: 'Replaced by a newer version',
        }),
      ]),
    });
    expect(formsWith(container, 'rule.retire')).toHaveLength(2);
    expect(
      formsWith(container, 'rule.retire')[0]?.querySelector<HTMLTextAreaElement>(
        'textarea[name="reason"]',
      )?.required,
    ).toBe(true);
    expect(text(container)).toContain('Replaced by a newer version');
    cleanup();
    const none = rulesPage({ ctx: contextFor(['platform.features.manage'], '/accounts/rules') });
    expect(formsWith(none.container, 'rule.retire')).toHaveLength(0);
    expect(ops(none.container)).toEqual([]);
  });

  it('drafts a rule with nothing chosen for the person', () => {
    const { container } = rulesPage();
    const form = formsWith(container, 'rule.draft')[0];
    expect(form).toBeTruthy();
    for (const name of ['ifscRequired', 'evidenceLabel'])
      expect(form?.querySelector<HTMLSelectElement>(`select[name="${name}"]`)?.value).toBe('');
    for (const name of ['country', 'accountType', 'minDigits', 'maxDigits'])
      expect(form?.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value).toBe('');
    cleanup();
    const verifier = rulesPage({ ctx: asVerifier('/accounts/rules') });
    expect(formsWith(verifier.container, 'rule.draft')).toHaveLength(0);
  });

  describe('key versions', () => {
    it('says none exists, and offers to propose one', () => {
      const { container } = rulesPage();
      expect(screen.getByText('No key versions')).toBeTruthy();
      expect(formsWith(container, 'keyversion.propose')).toHaveLength(1);
    });

    it('never shows key material, only the version, its status and who did what', () => {
      const { container } = rulesPage({ keys: list([keyVersion({ note: 'First version' })]) });
      const t = text(container);
      expect(t).toContain('Key version 1');
      expect(t).toContain('Active');
      expect(t).toContain('First version');
      expect(t).toContain('The key itself is never shown here.');
    });

    it('offers approval to a different person than the proposer, and explains it to the proposer', () => {
      const proposed = (by: string) =>
        list([
          keyVersion({ status: 'proposed', proposedBy: by, approvedBy: null, approvedAt: null }),
        ]);
      const other = rulesPage({ keys: proposed(OTHER), ctx: asVerifier('/accounts/rules') });
      expect(formsWith(other.container, 'keyversion.approve')).toHaveLength(1);
      cleanup();
      const own = rulesPage({ keys: proposed(ME), ctx: asVerifier('/accounts/rules') });
      expect(formsWith(own.container, 'keyversion.approve')).toHaveLength(0);
      expect(text(own.container)).toContain(
        'You proposed this version, so a different person must approve it.',
      );
      cleanup();
      const manager = rulesPage({ keys: proposed(OTHER), ctx: asManager('/accounts/rules') });
      expect(formsWith(manager.container, 'keyversion.approve')).toHaveLength(0);
    });

    it('does not offer a second proposal while one is waiting', () => {
      const { container } = rulesPage({
        keys: list([keyVersion({ status: 'proposed', approvedBy: null, approvedAt: null })]),
      });
      expect(formsWith(container, 'keyversion.propose')).toHaveLength(0);
      expect(text(container)).toContain('A version is already proposed.');
    });
  });

  it('shows load failures without the server’s text', () => {
    const { container } = rulesPage({
      rules: fail(500, 'upstream_internal_detail'),
      keys: fail(403, 'forbidden'),
    });
    expect(text(container)).toContain('Could not load the format rules');
    expect(text(container)).toContain('You cannot view the key versions');
    expect(text(container)).not.toContain('upstream_internal_detail');
  });
});

// =====================================================================================================================
describe('Settlement accounts', () => {
  const view = (over: Partial<Parameters<typeof SettlementPage>[0]> = {}) =>
    render(
      <SettlementPage
        accounts={page([settlement()])}
        verified={page([
          registryEntry({
            id: REGISTRY_1,
            verificationStatus: 'verified',
            verifiedBy: OTHER,
            verifiedAt: '2026-10-18T10:00:00+05:30',
            evidenceRef: 'Sample bank letter 3',
          }),
          registryEntry({
            id: REGISTRY_2,
            ownerOrgId: LENDER_B,
            verificationStatus: 'verified',
            verifiedBy: OTHER,
            verifiedAt: '2026-10-18T10:00:00+05:30',
            evidenceRef: 'Sample bank letter 4',
          }),
        ])}
        lenders={FINANCE}
        query={{}}
        ctx={full('/accounts/settlement')}
        notice={NONE}
        {...over}
      />,
    );

  it('lists a request with its label, bank, masked reference and lender, and how far it has got', () => {
    const { container } = view();
    const t = text(container);
    expect(t).toContain(`Collections account, XXXXXX${CANARY_LAST_FOUR}`);
    expect(t).toContain('Sample Finance');
    expect(t).toContain('Sample Bank');
    expect(t).toContain('Not linked to a registry entry');
  });

  it('offers only verified entries that the same lender owns, shown by masked reference', () => {
    const { container } = view();
    const form = formsWith(container, 'settlement.link')[0];
    const options = [...(form?.querySelectorAll('select[name="registryId"] option') ?? [])].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(options).toEqual(['', REGISTRY_1]);
    expect(hiddenIn(form as Element, 'id')).toBe(settlement().id);
  });

  it('says what to do first when the lender owns no verified entry', () => {
    const { container } = view({ verified: page([]) });
    expect(formsWith(container, 'settlement.link')).toHaveLength(0);
    expect(text(container)).toContain(
      'No verified registry entry owned by this lender is available to link',
    );
  });

  it('offers no link for an account that is linked or revoked, nor to a role that cannot link', () => {
    const linked = view({
      accounts: page([settlement({ registryId: REGISTRY_1, status: 'verified' })]),
    });
    expect(formsWith(linked.container, 'settlement.link')).toHaveLength(0);
    expect(text(linked.container)).toContain('Linked to a verified registry entry');
    cleanup();
    const revoked = view({ accounts: page([settlement({ status: 'revoked' })]) });
    expect(formsWith(revoked.container, 'settlement.link')).toHaveLength(0);
    cleanup();
    const verifier = view({ ctx: asVerifier('/accounts/settlement'), verified: null });
    expect(formsWith(verifier.container, 'settlement.link')).toHaveLength(0);
    expect(text(verifier.container)).toContain('Your role cannot link settlement accounts.');
  });

  it('says when the verified entries could not be read or are more than shown', () => {
    const failed = view({ verified: fail(500, 'upstream_internal_detail') });
    expect(text(failed.container)).toContain('The verified registry entries could not be read');
    expect(text(failed.container)).not.toContain('upstream_internal_detail');
    expect(formsWith(failed.container, 'settlement.link')).toHaveLength(0);
    cleanup();
    const more = view({ verified: page([], 'more_cursor') });
    expect(text(more.container)).toContain('More verified entries exist than are listed here');
  });

  it('shows an empty list and a failed list in words', () => {
    view({ accounts: page([]) });
    expect(screen.getByText('No settlement accounts')).toBeTruthy();
    cleanup();
    const { container } = view({ accounts: fail(403, 'forbidden') });
    expect(text(container)).toContain('You cannot view the settlement accounts');
  });
});

// =====================================================================================================================
describe('Merchants', () => {
  const view = (over: Partial<Parameters<typeof MerchantsPage>[0]> = {}) =>
    render(
      <MerchantsPage
        merchants={page([merchant(), feeMerchant()])}
        providers={[provider()]}
        lenders={FINANCE}
        query={{}}
        ctx={full('/accounts/merchants')}
        notice={NONE}
        {...over}
      />,
    );

  it('keeps Udofin’s fee merchant apart from the lenders’ merchants and says it can never take a repayment', () => {
    const { container } = view();
    const t = text(container);
    expect(t).toContain('Lenders’ repayment merchants');
    expect(t).toContain('Udofin’s fee merchants');
    expect(t).toContain('A lender’s payment configuration can never use it.');
    expect(t).toContain('MERCH-SAMPLE-1');
    expect(t).toContain('FEES-SAMPLE-1');
  });

  it('offers verification only for an unverified active merchant, and revocation for any active one', () => {
    const { container } = view();
    expect(formsWith(container, 'merchant.verify').map((f) => hiddenIn(f, 'id'))).toEqual([
      merchant().id,
    ]);
    expect(formsWith(container, 'merchant.revoke')).toHaveLength(2);
    expect(
      formsWith(container, 'merchant.revoke')[0]?.querySelector<HTMLTextAreaElement>(
        'textarea[name="reason"]',
      )?.required,
    ).toBe(true);
    cleanup();
    const revoked = view({
      merchants: page([
        merchant({
          status: 'revoked',
          revokedAt: '2026-10-18T10:00:00+05:30',
          revokedReason: 'Provider closed the merchant',
        }),
      ]),
    });
    expect(ops(revoked.container).filter((o) => o.startsWith('merchant.'))).toEqual([]);
    expect(text(revoked.container)).toContain('Provider closed the merchant');
  });

  it('shows no write form to a role without the provider permission', () => {
    for (const ctx of [
      asManager('/accounts/merchants'),
      asVerifier('/accounts/merchants'),
      nobody('/accounts/merchants'),
    ]) {
      const { container } = view({ ctx });
      expect(ops(container)).toEqual([]);
      expect(text(container)).toContain('Your role cannot verify or revoke merchants.');
      cleanup();
    }
  });

  it('registers the fee merchant from the register of providers, or by typing the provider’s key', () => {
    const { container } = view();
    const form = formsWith(container, 'feemerchant.register')[0];
    expect(form?.querySelector('select[name="provider"]')).toBeTruthy();
    expect(form?.querySelector<HTMLSelectElement>('select[name="provider"]')?.value).toBe('');
    cleanup();
    const typed = view({ providers: null });
    expect(
      formsWith(typed.container, 'feemerchant.register')[0]?.querySelector(
        'input[name="provider"]',
      ),
    ).toBeTruthy();
  });

  it('says when there is nothing, and when the list cannot be read', () => {
    view({ merchants: page([]) });
    expect(screen.getByText('No merchants')).toBeTruthy();
    expect(screen.getByText('No fee merchant')).toBeTruthy();
    cleanup();
    const { container } = view({ merchants: fail(500, 'upstream_internal_detail') });
    expect(text(container)).toContain('Could not load the merchants');
    expect(text(container)).not.toContain('upstream_internal_detail');
  });
});

// =====================================================================================================================
describe('Feature switches', () => {
  const switches = (over: Record<string, object> = {}) =>
    list(
      CATALOGUE.map((c) =>
        switchState(c.feature, { enableable: c.enableable, ...(over[c.feature] ?? {}) }),
      ),
    );
  const view = (over: Partial<Parameters<typeof FeaturesPage>[0]> = {}) =>
    render(
      <FeaturesPage
        catalogue={list(CATALOGUE)}
        lenderId={LENDER_A}
        switches={switches()}
        requests={page([])}
        lenders={FINANCE}
        query={{ lenderId: LENDER_A }}
        ctx={full('/features')}
        notice={NONE}
        {...over}
      />,
    );
  const cardOf = (container: HTMLElement, feature: string) =>
    [...container.querySelectorAll('article')].find(
      (a) => a.querySelector('h3')?.textContent === feature,
    );

  describe('collections and the default loss guarantee', () => {
    it('are shown as not available in this release, with no control to enable them', () => {
      const { container } = view();
      for (const feature of ['Collections', 'Default loss guarantee (DLG)']) {
        const card = cardOf(container, feature);
        expect(card, feature).toBeTruthy();
        expect(card?.textContent).toContain('Not available in this release.');
        expect(card?.textContent).toContain('This switch cannot be enabled.');
        expect(card?.querySelector('form')).toBeNull();
        expect(card?.querySelector('input, button, select, textarea')).toBeNull();
      }
      // No form in the whole page mentions either feature.
      for (const form of container.querySelectorAll('form'))
        expect(['collections', 'dlg']).not.toContain(hiddenIn(form, 'feature'));
    });

    it('stay locked in the catalogue view, where no lender is chosen', () => {
      const { container } = view({ lenderId: undefined, switches: null, query: {} });
      expect(text(container)).toContain('Not available in this release.');
      expect(container.querySelector('form[action] input[name="feature"]')).toBeNull();
      expect(ops(container)).toEqual([]);
    });

    it('stay locked even if the catalogue wrongly called them enableable (a second, independent list)', () => {
      const wrong = list([
        catalogueEntry('collections'),
        catalogueEntry('dlg'),
        catalogueEntry('payments'),
      ]);
      const { container } = view({
        catalogue: wrong,
        switches: list([switchState('collections'), switchState('dlg'), switchState('payments')]),
      });
      for (const feature of ['Collections', 'Default loss guarantee (DLG)']) {
        expect(cardOf(container, feature)?.querySelector('form'), feature).toBeNull();
        expect(cardOf(container, feature)?.textContent).toContain('cannot be enabled');
      }
      expect(cardOf(container, 'Payments')?.querySelector('form')).toBeTruthy();
    });

    it('stay locked for any feature the catalogue calls not enableable, whatever its name', () => {
      const { container } = view({
        catalogue: list([
          catalogueEntry('reminders', { enableable: false, lockedReason: null }),
          catalogueEntry('payments'),
        ]),
        switches: list([switchState('reminders', { enableable: false }), switchState('payments')]),
      });
      expect(cardOf(container, 'Reminders')?.querySelector('form')).toBeNull();
      expect(cardOf(container, 'Reminders')?.textContent).toContain(
        'Not available in this release.',
      );
      expect(cardOf(container, 'Payments')?.querySelector('form')).toBeTruthy();
    });

    it('show the catalogue’s own recorded reason', () => {
      const { container } = view();
      expect(text(container)).toContain(
        'As the catalogue records it: Phase 08b is not authorised.',
      );
    });
  });

  describe('a switch that can be changed', () => {
    it('shows an off switch with a request-to-enable form that has nothing filled in', () => {
      const { container } = view();
      const card = cardOf(container, 'Payments');
      expect(card?.textContent).toContain('Off');
      const form = formsWith(card as HTMLElement, 'feature.request')[0];
      expect(hiddenIn(form as Element, 'direction')).toBe('on');
      expect(hiddenIn(form as Element, 'feature')).toBe('payments');
      expect(hiddenIn(form as Element, 'lenderId')).toBe(LENDER_A);
      for (const input of form?.querySelectorAll<HTMLInputElement>('input[name^="evidence"]') ?? [])
        expect(input.value).toBe('');
      expect(form?.querySelectorAll('input[name^="evidenceLabel"]')).toHaveLength(3);
      expect(form?.querySelector('input[type="checkbox"]')).toBeNull();
      expect(text(form as HTMLElement)).toContain('the reasons are listed in plain words');
    });

    it('shows an on switch since when, with a two-person switch-off and an emergency switch-off', () => {
      const { container } = view({
        switches: switches({ payments: { enabled: true, enabledAt: '2026-10-10T10:00:00+05:30' } }),
      });
      const card = cardOf(container, 'Payments');
      expect(card?.textContent).toContain('On since 10 Oct 2026, 10:00 IST');
      const off = formsWith(card as HTMLElement, 'feature.request')[0];
      expect(hiddenIn(off as Element, 'direction')).toBe('off');
      expect(off?.querySelector<HTMLTextAreaElement>('textarea[name="reason"]')?.required).toBe(
        true,
      );
      expect(formsWith(card as HTMLElement, 'feature.request')).toHaveLength(1);
      expect(formsWith(card as HTMLElement, 'feature.kill')).toHaveLength(1);
    });

    it('asks for one confirmation and a reason for the emergency switch-off, and ticks nothing for the person', () => {
      const { container } = view({
        switches: switches({ payments: { enabled: true, enabledAt: '2026-10-10T10:00:00+05:30' } }),
      });
      const kill = formsWith(container, 'feature.kill')[0];
      const confirm = kill?.querySelector<HTMLInputElement>('input[name="confirm"]');
      expect(confirm?.type).toBe('checkbox');
      expect(confirm?.checked).toBe(false);
      expect(confirm?.required).toBe(true);
      expect(kill?.querySelector<HTMLTextAreaElement>('textarea[name="reason"]')?.required).toBe(
        true,
      );
      expect(text(kill as HTMLElement)).toContain('without a second person');
      expect(text(kill as HTMLElement)).toContain('It can only switch off');
      // Nothing on the page offers an emergency switch-ON.
      for (const form of container.querySelectorAll('form'))
        if (hiddenIn(form, 'op') === 'feature.kill')
          expect(form.querySelector('input[name="direction"]')).toBeNull();
    });

    it('says when a switch has never been switched on, and shows when it was switched off', () => {
      const never = view({ switches: list([]) });
      expect(text(cardOf(never.container, 'Payments') as HTMLElement)).toContain(
        'it has never been switched on for this lender',
      );
      cleanup();
      const off = view({
        switches: switches({ payments: { disabledAt: '2026-10-12T10:00:00+05:30' } }),
      });
      expect(text(cardOf(off.container, 'Payments') as HTMLElement)).toContain(
        'Off since 12 Oct 2026, 10:00 IST',
      );
    });

    it('offers no new request while one waits for a decision, and says so', () => {
      const { container } = view({ requests: page([changeRequest()]) });
      const card = cardOf(container, 'Payments');
      expect(formsWith(card as HTMLElement, 'feature.request')).toHaveLength(0);
      expect(card?.textContent).toContain('A request for this switch is waiting for a decision');
      // A pending request for another lender or feature does not block this one.
      cleanup();
      const elsewhere = view({
        requests: page([
          changeRequest({ lenderId: LENDER_B }),
          changeRequest({ id: EXCEPTION_2, feature: 'reminders' }),
        ]),
      });
      expect(
        formsWith(cardOf(elsewhere.container, 'Payments') as HTMLElement, 'feature.request'),
      ).toHaveLength(1);
    });

    it('shows no switch form to a role without the features permission', () => {
      const { container } = view({
        ctx: contextFor(['platform.payments.providers.manage'], '/features'),
        switches: switches({ payments: { enabled: true, enabledAt: '2026-10-10T10:00:00+05:30' } }),
      });
      expect(ops(container)).toEqual([]);
      expect(text(container)).toContain('Your role cannot change feature switches.');
    });

    it('shows a failed load of the switches without the server’s text, and no form', () => {
      const { container } = view({ switches: fail(500, 'upstream_internal_detail') });
      expect(text(container)).toContain('Could not load the switches of this lender');
      expect(text(container)).not.toContain('upstream_internal_detail');
      expect(ops(container)).toEqual([]);
    });

    it('says that a lender that does not exist looks like one with everything off', () => {
      const { container } = view();
      expect(text(container)).toContain('looks the same here as a lender with every switch off');
    });
  });

  describe('requests', () => {
    it('shows a pending request with its evidence, when it runs out, and that a different person decides', () => {
      const { container } = view({ requests: page([changeRequest()]) });
      const t = text(container);
      expect(t).toContain('Payments: switch on for Sample Finance');
      expect(t).toContain('Pending: waiting for a different person to decide');
      expect(t).toContain('Two-person change');
      expect(t).toContain('contract reference: Sample agreement 7');
      expect(t).toContain('25 Oct 2026, 09:30 IST');
    });

    it('offers the decision to a different person, with a note that a rejection needs', () => {
      const { container } = view({ requests: page([changeRequest({ requestedBy: OTHER })]) });
      const form = formsWith(container, 'feature.decide')[0];
      expect(form).toBeTruthy();
      expect(hiddenIn(form as Element, 'id')).toBe(changeRequest().id);
      const buttons = [...(form?.querySelectorAll('button[name="verdict"]') ?? [])].map(
        (b) => (b as HTMLButtonElement).value,
      );
      expect(buttons).toEqual(['approve', 'reject']);
      expect(text(form as HTMLElement)).toContain('Required when you reject');
    });

    it('does not offer the decision to the requester, offers cancelling instead, and says why', () => {
      const { container } = view({ requests: page([changeRequest({ requestedBy: ME })]) });
      expect(formsWith(container, 'feature.decide')).toHaveLength(0);
      expect(formsWith(container, 'feature.cancel')).toHaveLength(1);
      expect(text(container)).toContain(
        'You made this request, so a different person must decide it.',
      );
    });

    it('offers neither to a role without the features permission', () => {
      const { container } = view({
        ctx: asVerifier('/features'),
        requests: page([changeRequest({ requestedBy: OTHER })]),
      });
      expect(formsWith(container, 'feature.decide')).toHaveLength(0);
      expect(formsWith(container, 'feature.cancel')).toHaveLength(0);
    });

    it('offers nothing for a request that is decided, and words each outcome honestly', () => {
      const decided = (status: string, over: object = {}) =>
        changeRequest({
          id: REGISTRY_1,
          status,
          requestedBy: OTHER,
          decidedBy: ME,
          decidedAt: '2026-10-19T09:30:00+05:30',
          ...over,
        });
      const { container } = view({
        requests: page([
          decided('applied', { appliedAt: '2026-10-19T09:30:00+05:30' }),
          decided('rejected', { id: REGISTRY_2, decisionNote: 'Evidence does not match' }),
          decided('expired', { id: REGISTRY_3 }),
          decided('cancelled', { id: EXCEPTION_1 }),
        ]),
      });
      const t = text(container);
      expect(t).toContain('Applied: the switch changed');
      expect(t).toContain('Rejected: nothing changed');
      expect(t).toContain('Evidence does not match');
      expect(t).toContain('Expired: not applied, nothing changed');
      expect(t).toContain('Cancelled: nothing changed');
      expect(formsWith(container, 'feature.decide')).toHaveLength(0);
      expect(formsWith(container, 'feature.cancel')).toHaveLength(0);
    });

    it('shows an emergency switch-off as one person’s act', () => {
      const { container } = view({
        requests: page([
          changeRequest({
            enable: false,
            mode: 'emergency',
            status: 'applied',
            reason: 'Provider reported a fault',
            appliedAt: '2026-10-19T09:30:00+05:30',
          }),
        ]),
      });
      expect(text(container)).toContain('Emergency switch-off by one person');
      expect(text(container)).toContain('Provider reported a fault');
      expect(text(container)).toContain('switch off for Sample Finance');
    });

    it('says when there are none, and when they cannot be read', () => {
      view();
      expect(screen.getByText('No requests')).toBeTruthy();
      cleanup();
      const { container } = view({ requests: fail(403, 'forbidden') });
      expect(text(container)).toContain('You cannot view the requests');
    });
  });

  describe('the notice after an action', () => {
    it('lists the reasons a refused request gave, in plain words and never as identifiers', () => {
      const { container } = view({
        notice: {
          error: 'prerequisites_unmet',
          reasons: 'payment_config_missing,onboarding_gate_not_activated,brand_new_reason',
        },
      });
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('The lender does not yet meet what this switch needs');
      expect(alert?.textContent).toContain(
        'There is no active payment configuration in production mode.',
      );
      expect(alert?.textContent).toContain(
        'The lender’s onboarding has not reached the activated stage.',
      );
      expect(alert?.textContent).toContain('Another reason that this screen has no wording for.');
      expect(alert?.textContent).not.toContain('payment_config_missing');
      expect(alert?.textContent).not.toContain('brand_new_reason');
    });

    it('says what a decision did, including that an expired request changed nothing', () => {
      for (const [result, expected] of [
        ['applied', 'the switch has changed'],
        ['rejected', 'Nothing changed'],
        ['expired', 'not applied'],
      ] as const) {
        const { container } = view({ notice: { done: true, result } });
        expect(container.querySelector('[role="status"]')?.textContent, result).toContain(expected);
        cleanup();
      }
      const odd = view({ notice: { done: true, result: '<b>applied</b>' } });
      expect(text(odd.container)).toContain('Your action was recorded.');
    });

    it('maps a switch refusal to its sentence', () => {
      const { container } = view({ notice: { error: 'feature_not_enableable' } });
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'This feature cannot be enabled in this release.',
      );
    });
  });
});

// =====================================================================================================================
describe('Platform exceptions', () => {
  const view = (over: Partial<Parameters<typeof ExceptionsPage>[0]> = {}) =>
    render(
      <ExceptionsPage
        open={page([platformException()])}
        resolved={null}
        view="open"
        lenders={FINANCE}
        query={{}}
        ctx={full('/exceptions')}
        notice={NONE}
        {...over}
      />,
    );

  it('words the class, severity, status, lender and identifiers of an exception', () => {
    const { container } = view();
    const t = text(container);
    expect(t).toContain('The provider named a different merchant from the one configured');
    expect(t).toContain('Critical');
    expect(t).toContain('Open: nobody has acknowledged it');
    expect(t).toContain('Sample Finance');
    expect(t).toContain('Udofin staff');
    expect(t).toContain('Not assigned');
    expect(t).toContain('provider: sample_pay');
  });

  it('prints only identifier-shaped values of the subject and counts what it left out', () => {
    const { container } = view({
      open: page([
        platformException({
          subject: {
            provider: 'sample_pay',
            note: 'Mr Sample paid 9876543210 in cash',
            'Bad Key': 'x',
          },
        }),
      ]),
    });
    const t = text(container);
    expect(t).toContain('provider: sample_pay');
    expect(t).not.toContain('Mr Sample');
    expect(t).not.toContain('9876543210');
    expect(t).toContain(
      '2 recorded values are not shown because they do not look like an identifier.',
    );
  });

  it('says it has no wording for an unknown class instead of printing it', () => {
    const { container } = view({ open: page([platformException({ class: 'zz_new_kind' })]) });
    expect(text(container)).toContain('A kind of exception this screen has no wording for');
    expect(text(container)).not.toContain('zz_new_kind');
  });

  describe('which forms are offered for which status', () => {
    const formsFor = (status: string, owner = 'platform', ctx = full('/exceptions')) => {
      const { container } = view({ open: page([platformException({ status, owner })]), ctx });
      const found = ops(container);
      cleanup();
      return found;
    };

    it('offers acknowledge, assign and resolve while it is not resolved; acknowledge only when nobody has', () => {
      expect(formsFor('open')).toEqual([
        'exception.acknowledge',
        'exception.assign',
        'exception.resolve',
      ]);
      expect(formsFor('reopened')).toEqual([
        'exception.acknowledge',
        'exception.assign',
        'exception.resolve',
      ]);
      expect(formsFor('acknowledged')).toEqual(['exception.assign', 'exception.resolve']);
      expect(formsFor('assigned')).toEqual(['exception.assign', 'exception.resolve']);
    });

    it('offers only reopening once it is resolved', () => {
      expect(formsFor('resolved')).toEqual(['exception.reopen']);
    });

    it('offers nothing for an exception the lender owns, and says the lender works it', () => {
      expect(formsFor('open', 'lender')).toEqual([]);
      const { container } = view({ open: page([platformException({ owner: 'lender' })]) });
      expect(text(container)).toContain(
        'This exception is worked by the lender. You can read it here.',
      );
      expect(text(container)).toContain('The lender');
    });

    it('offers nothing to a role without the provider permission', () => {
      for (const ctx of [
        nobody('/exceptions'),
        asManager('/exceptions'),
        asVerifier('/exceptions'),
        contextFor(['platform.features.manage'], '/exceptions'),
      ])
        expect(formsFor('open', 'platform', ctx)).toEqual([]);
      const { container } = view({ ctx: nobody('/exceptions') });
      expect(text(container)).toContain('Your role cannot work exceptions.');
    });
  });

  it('assigns to the person by default, which they can replace, and shows who it is assigned to', () => {
    const { container } = view();
    const form = formsWith(container, 'exception.assign')[0];
    expect(form?.querySelector<HTMLInputElement>('input[name="assignee"]')?.value).toBe(ME);
    cleanup();
    const mine = view({ open: page([platformException({ assignedTo: ME, status: 'assigned' })]) });
    expect(text(mine.container)).toContain('Assigned to you');
    cleanup();
    const theirs = view({
      open: page([platformException({ assignedTo: OTHER, status: 'assigned' })]),
    });
    expect(text(theirs.container)).toContain('Assigned to another member of staff');
    expect(text(theirs.container)).not.toContain(OTHER);
  });

  it('resolves with a reason from the closed list and references to what was checked, none chosen for the person', () => {
    const { container } = view();
    const form = formsWith(container, 'exception.resolve')[0];
    const reason = form?.querySelector<HTMLSelectElement>('select[name="reasonCode"]');
    expect(reason?.value).toBe('');
    expect(reason?.required).toBe(true);
    const labels = [...(reason?.options ?? [])].map((o) => o.textContent);
    expect(labels).toContain('Checked with the provider');
    expect(labels).toHaveLength(12);
    expect(form?.querySelectorAll('input[name^="evidence"]')).toHaveLength(3);
    expect(form?.querySelector<HTMLInputElement>('input[name="evidence1"]')?.required).toBe(true);
    expect(text(form as HTMLElement)).toContain('it does not move money or alter a payment');
  });

  it('reopens a resolved exception with a reason from the reopen list only', () => {
    const { container } = view({
      view: 'resolved',
      resolved: page([
        platformException({ status: 'resolved', resolvedAt: '2026-10-19T09:30:00+05:30' }),
      ]),
    });
    const form = formsWith(container, 'exception.reopen')[0];
    const labels = [
      ...(form?.querySelector<HTMLSelectElement>('select[name="reasonCode"]')?.options ?? []),
    ].map((o) => o.textContent);
    expect(labels).toContain('New information received');
    expect(labels).not.toContain('Confirmed to be a duplicate');
    expect(text(container)).toContain('Resolved exceptions');
  });

  it('links the two views and says which one is shown', () => {
    const { container } = view({ view: 'resolved', resolved: page([]) });
    const links = [...container.querySelectorAll('nav[aria-label="Exception views"] a')];
    expect(links.map((a) => a.textContent)).toEqual(['Not resolved', 'Resolved']);
    expect(links[1]?.getAttribute('aria-current')).toBe('page');
    expect(links[0]?.getAttribute('aria-current')).toBeNull();
    expect(screen.getByText('Nothing resolved')).toBeTruthy();
  });

  it('says when nothing is open and when the list cannot be read', () => {
    view({ open: page([]) });
    expect(screen.getByText('No open exceptions')).toBeTruthy();
    cleanup();
    const { container } = view({ open: fail(500, 'upstream_internal_detail') });
    expect(text(container)).toContain('Could not load the exceptions');
    expect(text(container)).not.toContain('upstream_internal_detail');
  });

  it('keeps the severity filter in the links to older pages', () => {
    const { container } = view({
      open: page([platformException()], 'c2'),
      query: { severity: 'critical' },
    });
    const link = [...container.querySelectorAll('a')].find(
      (a) => a.textContent === 'Older exceptions',
    );
    expect(link?.getAttribute('href')).toBe('/exceptions?severity=critical&view=open&cursor=c2');
  });

  describe('the history of one exception', () => {
    it('lists what happened with the actor kind, reasons in words and evidence labels', () => {
      const detail = exceptionDetail({
        exception: platformException({
          status: 'resolved',
          resolvedAt: '2026-10-19T09:30:00+05:30',
        }),
        events: [
          {
            id: '0190a000-0000-7000-8000-000000000711',
            action: 'opened',
            actorKind: 'system',
            actorUserId: null,
            reasonCode: null,
            evidence: null,
            note: null,
            assignedTo: null,
            authorisedByPermission: null,
            occurredAt: '2026-10-18T09:30:00+05:30',
          },
          {
            id: '0190a000-0000-7000-8000-000000000712',
            action: 'resolved',
            actorKind: 'platform_user',
            actorUserId: ME,
            reasonCode: 'verified_with_provider',
            evidence: ['PROVIDER-TICKET-77', 'two words'],
            note: 'Provider confirmed',
            assignedTo: null,
            authorisedByPermission: 'platform.payments.providers.manage',
            occurredAt: '2026-10-19T09:30:00+05:30',
          },
        ],
      });
      const { container } = render(
        <ExceptionDetailPage
          detail={ok(detail)}
          lenders={FINANCE}
          ctx={full('/exceptions/x')}
          notice={NONE}
        />,
      );
      const t = text(container);
      expect(t).toContain('Opened by the system');
      expect(t).toContain('by the system');
      expect(t).toContain('by a member of Udofin staff (you)');
      expect(t).toContain('Reason: Checked with the provider.');
      expect(t).toContain('Evidence: PROVIDER-TICKET-77.');
      // A reference that is not identifier-shaped is not printed.
      expect(t).not.toContain('two words');
      expect(t).toContain('Note written by staff: Provider confirmed');
    });

    it('shows a stored reason that is not on the closed list as nothing at all', () => {
      const detail = exceptionDetail({
        events: [
          {
            id: '0190a000-0000-7000-8000-000000000713',
            action: 'resolved',
            actorKind: 'platform_user',
            actorUserId: OTHER,
            reasonCode: 'free text reason',
            evidence: null,
            note: null,
            assignedTo: null,
            authorisedByPermission: null,
            occurredAt: '2026-10-19T09:30:00+05:30',
          },
        ],
      });
      const { container } = render(
        <ExceptionDetailPage
          detail={ok(detail)}
          lenders={FINANCE}
          ctx={full('/exceptions/x')}
          notice={NONE}
        />,
      );
      expect(text(container)).not.toContain('free text reason');
      expect(text(container)).not.toContain('Reason:');
    });

    it('says in words when it cannot be read', () => {
      const { container } = render(
        <ExceptionDetailPage
          detail={fail(404, 'not_found')}
          lenders={null}
          ctx={full('/exceptions/x')}
          notice={NONE}
        />,
      );
      expect(text(container)).toContain('Could not load this exception');
      expect(text(container)).not.toContain('not_found');
    });
  });
});

// =====================================================================================================================
describe('across all the screens', () => {
  const everything = (): ReactElement[] => [
    <ProvidersPage
      key="p"
      providers={list([
        provider(),
        provider({
          provider: 'second_pay',
          evidenceLabel: 'unverified',
          authorisationEvidenceRef: null,
        }),
      ])}
      returnCodes={list([returnCode()])}
      ctx={full('/providers')}
      notice={NONE}
    />,
    registry({
      registered: ok(registryEntry()),
      keys: list([
        keyVersion(),
        keyVersion({ keyVersion: 2, status: 'proposed', approvedBy: null, approvedAt: null }),
      ]),
      accounts: page([
        registryEntry({ registeredBy: OTHER }),
        registryEntry({
          id: REGISTRY_2,
          ownerKind: 'udofin',
          ownerOrgId: null,
          permittedPurposes: ['fee_collection'],
        }),
      ]),
    }),
    <RulesPage
      key="r"
      rules={list([rule(), approvedRule({ id: RULE_2 })])}
      keys={list([keyVersion({ status: 'proposed', approvedBy: null, approvedAt: null })])}
      query={{}}
      ctx={full('/accounts/rules')}
      notice={NONE}
    />,
    <SettlementPage
      key="s"
      accounts={page([settlement()])}
      verified={page([
        registryEntry({
          verificationStatus: 'verified',
          verifiedBy: OTHER,
          verifiedAt: '2026-10-18T10:00:00+05:30',
          evidenceRef: 'Sample bank letter 3',
        }),
      ])}
      lenders={FINANCE}
      query={{}}
      ctx={full('/accounts/settlement')}
      notice={NONE}
    />,
    <MerchantsPage
      key="m"
      merchants={page([merchant(), feeMerchant()])}
      providers={[provider()]}
      lenders={FINANCE}
      query={{}}
      ctx={full('/accounts/merchants')}
      notice={NONE}
    />,
    <FeaturesPage
      key="f"
      catalogue={list(CATALOGUE)}
      lenderId={LENDER_A}
      switches={list(
        CATALOGUE.map((c) =>
          switchState(c.feature, {
            enableable: c.enableable,
            enabled: c.enableable,
            enabledAt: c.enableable ? '2026-10-10T10:00:00+05:30' : null,
          }),
        ),
      )}
      requests={page([changeRequest({ requestedBy: OTHER })])}
      lenders={FINANCE}
      query={{}}
      ctx={full('/features')}
      notice={NONE}
    />,
    <ExceptionsPage
      key="e"
      open={page([platformException(), platformException({ id: EXCEPTION_2, status: 'resolved' })])}
      resolved={null}
      view="open"
      lenders={FINANCE}
      query={{}}
      ctx={full('/exceptions')}
      notice={NONE}
    />,
  ];

  it('gives every control a label and ticks no box for the person', () => {
    for (const element of everything()) {
      const { container } = render(element);
      const controls = container.querySelectorAll<HTMLInputElement>(
        'input:not([type="hidden"]), select, textarea',
      );
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) {
        const labelled = (control.labels?.length ?? 0) > 0 || control.hasAttribute('aria-label');
        expect(labelled, `${control.tagName} ${control.name}`).toBe(true);
      }
      expect(container.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(0);
      expect(container.querySelectorAll('input[type="radio"]:checked')).toHaveLength(0);
      cleanup();
    }
  });

  it('puts a heading on each page and names the table captions for screen readers', () => {
    for (const element of everything()) {
      const { container } = render(element);
      expect(container.querySelectorAll('h1')).toHaveLength(1);
      for (const table of container.querySelectorAll('table'))
        expect(table.querySelector('caption')).toBeTruthy();
      cleanup();
    }
  });

  it('never claims compliance, regulatory approval or safety', () => {
    for (const element of everything()) {
      const { container } = render(element);
      expect(text(container)).not.toMatch(
        /complian|regulat|\bRBI\b|\bsafe\b|\bsafety\b|\bsecure\b/i,
      );
      cleanup();
    }
  });

  it('shows no raw server code, whatever fails', () => {
    const bad = fail(500, 'upstream_internal_detail');
    const failing: ReactElement[] = [
      <ProvidersPage key="p" providers={bad} returnCodes={bad} ctx={full()} notice={NONE} />,
      registry({ accounts: bad, rules: bad, keys: bad, registered: bad }),
      <RulesPage key="r" rules={bad} keys={bad} query={{}} ctx={full()} notice={NONE} />,
      <SettlementPage
        key="s"
        accounts={bad}
        verified={bad}
        lenders={null}
        query={{}}
        ctx={full()}
        notice={NONE}
      />,
      <MerchantsPage
        key="m"
        merchants={bad}
        providers={null}
        lenders={null}
        query={{}}
        ctx={full()}
        notice={NONE}
      />,
      <FeaturesPage
        key="f"
        catalogue={bad}
        lenderId={LENDER_A}
        switches={bad}
        requests={bad}
        lenders={null}
        query={{}}
        ctx={full()}
        notice={NONE}
      />,
      <ExceptionsPage
        key="e"
        open={bad}
        resolved={null}
        view="open"
        lenders={null}
        query={{}}
        ctx={full()}
        notice={NONE}
      />,
      <ExceptionDetailPage key="d" detail={bad} lenders={null} ctx={full()} notice={NONE} />,
    ];
    for (const element of failing) {
      const { container } = render(element);
      expect(text(container)).not.toContain('upstream_internal_detail');
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
      cleanup();
    }
  });

  it('shows no raw error code or server text from the address, only the sentence for a known code', () => {
    const { container } = render(registry({ notice: { error: 'Some Raw Text 42 <b>x</b>' } }));
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('The action could not be completed. Nothing was changed.');
    expect(container.innerHTML).not.toContain('Raw Text');
  });

  it('writes mock and sandbox configurations as test only wherever they are named', () => {
    const t = kit.AccountsProvidersPage;
    expect(typeof t).toBe('function');
    // The word for a mock or sandbox configuration that cannot satisfy a gate says it is for testing only.
    const { container } = render(
      <FeaturesPage
        catalogue={list(CATALOGUE)}
        lenderId={LENDER_A}
        switches={list([])}
        requests={page([])}
        lenders={FINANCE}
        query={{}}
        ctx={full('/features')}
        notice={{ error: 'prerequisites_unmet', reasons: 'payment_config_mock_or_sandbox_only' }}
      />,
    );
    expect(text(container)).toContain('for testing only');
  });

  it('exports the screens, the loaders and the operations under prefixed names', () => {
    for (const name of [
      'AccountsProvidersPage',
      'AccountsRegistryPage',
      'AccountsRulesPage',
      'AccountsSettlementPage',
      'AccountsMerchantsPage',
      'AccountsFeaturesPage',
      'AccountsExceptionsPage',
      'AccountsExceptionDetailPage',
      'createPlatformClient',
      'platformCaps',
      'runAccountsOperation',
      'runAccountRegistration',
      'safeAccountsReturnPath',
      'accountsNoticeUrl',
      'accountRegisteredUrl',
    ])
      expect(typeof (kit as Record<string, unknown>)[name], name).toBe('function');
  });
});
