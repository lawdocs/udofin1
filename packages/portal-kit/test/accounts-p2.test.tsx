// @vitest-environment jsdom
// Phase 08a review fixes (P2), the screens: the own-account list (attest, withdraw), the suspended payment configurations with
// their holds and the release form, the hints on the feature-switch page, and the navigation between them. Every fixture is
// parsed by the real contract schema.
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FeaturesPage } from '../src/accounts/feature-views.js';
import { HoldsPage } from '../src/accounts/hold-views.js';
import { OwnAccountListPage } from '../src/accounts/own-list-views.js';
import { ProvidersPage } from '../src/accounts/provider-views.js';
import { RegistryPage } from '../src/accounts/registry-views.js';
import { type LenderChoice } from '../src/accounts/types.js';
import {
  ALL_PERMISSIONS,
  approvedRule,
  CATALOGUE,
  CONFIG_1,
  CONFIG_2,
  contextFor,
  fail,
  keyVersion,
  LENDER_A,
  LENDER_B,
  list,
  ME,
  NOW,
  OTHER,
  ownListEvent,
  ownListState,
  page,
  paymentConfig,
  provider,
  registryEntry,
  returnCode,
} from './accounts-fixtures.js';

afterEach(cleanup);

const text = (container: HTMLElement) => container.textContent ?? '';
const ops = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLInputElement>('input[name="op"]')].map((i) => i.value);
const NONE = {};
const BANNED = /complian|regulat|\bRBI\b|\bsafe\b|\bsafety\b|\bsecure\b/i;
const FINANCE: LenderChoice[] = [
  { id: LENDER_A, name: 'Sample Finance' },
  { id: LENDER_B, name: 'Other Credit' },
];
const VERIFY = ['platform.accounts.registry.verify'];
const MANAGE = ['platform.accounts.registry.manage'];
const PROVIDERS = ['platform.payments.providers.manage'];

// =====================================================================================================================
describe('Own-account list', () => {
  const view = (
    state: Parameters<typeof OwnAccountListPage>[0]['state'] = list([]) as never,
    permissions: readonly string[] = ALL_PERMISSIONS,
    notice: Parameters<typeof OwnAccountListPage>[0]['notice'] = NONE,
  ) =>
    render(
      <OwnAccountListPage
        state={state}
        ctx={contextFor(permissions, '/accounts/own-accounts')}
        notice={notice}
      />,
    );
  const attested = () => ({ ok: true as const, status: 200, data: ownListState() });
  const notAttested = (
    events = [
      ownListEvent({
        eventKind: 'withdrawn',
        evidenceRef: null,
        reason: 'An account was found that was missing',
        entriesCounted: null,
      }),
    ],
  ) => ({
    ok: true as const,
    status: 200,
    data: ownListState({ attested: false, events }),
  });
  const noKey = () => ({
    ok: true as const,
    status: 200,
    data: ownListState({ keyVersion: null, attested: false, events: [] }),
  });

  it('says in plain words what the list is and what an attestation does and does not mean', () => {
    const { container } = view(attested());
    const words = text(container);
    expect(words).toMatch(/Udofin and its group companies have bank accounts of their own/);
    expect(words).toMatch(
      /Until it is attested, no lender account can be verified or linked, and payments and mandates cannot be switched on/,
    );
    expect(words).toMatch(
      /An attestation is the platform’s own statement, made by one member of staff/,
    );
    expect(words).toMatch(/It is not proof/);
    expect(words).toMatch(/say what the list was reconciled against/);
    expect(words).toMatch(/the list has to be attested again/);
    expect(words).not.toMatch(BANNED);
  });

  it('shows an attested list with its evidence reference, who recorded it, when, and how many accounts were counted', () => {
    const { container } = view(attested());
    expect(text(container)).toContain('Attested for key version 1');
    expect(text(container)).toContain('Sample reconciliation sheet 4');
    expect(text(container)).toContain('18 Oct 2026, 09:30 IST by another member of staff');
    const facts = container.querySelector('dl.facts') as HTMLElement;
    expect(text(facts)).toContain('Verified own accounts counted');
    expect(text(facts)).toContain('2');
    cleanup();
    const mine = view({
      ok: true,
      status: 200,
      data: ownListState({ events: [ownListEvent({ actorId: ME })] }),
    });
    expect(text(mine.container)).toContain('by you');
  });

  it('shows a list that is not attested, what that stops, and the reason of the withdrawal that ended it', () => {
    const { container } = view(notAttested());
    expect(text(container)).toContain('Not attested for key version 1');
    expect(text(container)).toMatch(
      /Until it is attested: lender accounts cannot be verified or linked, and payments and mandates cannot be switched on/,
    );
    const table = screen.getByRole('table', {
      name: /Attestations and withdrawals for key version 1, newest first/,
    });
    expect(text(table)).toContain('Attestation withdrawn');
    expect(text(table)).toContain('An account was found that was missing');
  });

  it('says nothing has been recorded yet, and that there is nothing to attest without an active key version', () => {
    const empty = view(notAttested([]));
    expect(text(empty.container)).toContain('Not attested for key version 1');
    expect(text(empty.container)).toContain('Nothing has been recorded for this key version yet');
    cleanup();
    const none = view(noKey());
    expect(text(none.container)).toContain('Nothing to attest yet');
    expect(text(none.container)).toMatch(/No fingerprint key version is active/);
    expect(ops(none.container)).toEqual([]);
  });

  it('draws the attest form for a verifier, with an evidence reference, an optional note and a confirm tick that is not ticked', () => {
    const { container } = view(notAttested(), VERIFY);
    expect(ops(container)).toEqual(['ownlist.attest']);
    const evidence = screen.getByLabelText<HTMLInputElement>('Reference to the evidence');
    expect(evidence.required).toBe(true);
    expect(evidence.value).toBe('');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Note (optional)').value).toBe('');
    const tick = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"][name="confirm"]',
    );
    expect(tick?.required).toBe(true);
    expect(tick?.checked).toBe(false);
    expect(tick?.closest('label')?.textContent).toMatch(
      /recording the platform’s statement that the list of Udofin and group accounts in the registry is complete/,
    );
    const form = container.querySelector('form') as HTMLFormElement;
    expect(form.querySelector<HTMLInputElement>('input[name="key"]')?.value).toMatch(
      /^ui-[0-9a-f-]{36}$/,
    );
    expect(form.querySelector<HTMLInputElement>('input[name="returnTo"]')?.value).toBe(
      '/accounts/own-accounts',
    );
    expect(screen.getByRole('button', { name: 'Record the statement' })).toBeTruthy();
    // It says what the system refuses and that a repeat changes nothing, without a code.
    expect(text(form)).toMatch(
      /The system refuses the statement if the list is visibly incomplete/,
    );
    expect(text(form)).toMatch(/Attesting again with the same evidence changes nothing/);
  });

  it('can be attested again while it stands, with new evidence', () => {
    const { container } = view(attested(), VERIFY);
    expect(ops(container)).toContain('ownlist.attest');
  });

  it('offers the withdrawal only while the list is attested, to either registry right, with a required reason', () => {
    for (const permissions of [VERIFY, MANAGE]) {
      const { container } = view(attested(), permissions);
      expect(ops(container).includes('ownlist.withdraw'), permissions.join()).toBe(true);
      const reason = within(
        container.querySelector('input[value="ownlist.withdraw"]')?.closest('form') as HTMLElement,
      ).getByLabelText<HTMLTextAreaElement>('Reason');
      expect(reason.required).toBe(true);
      expect(text(container)).toMatch(
        /Withdrawing does not itself change any account, link or switch that already exists/,
      );
      cleanup();
    }
    const gone = view(notAttested(), ALL_PERMISSIONS);
    expect(ops(gone.container)).not.toContain('ownlist.withdraw');
  });

  it('attest is the verifier’s alone: a manager sees why there is no form, a person with neither sees no form at all', () => {
    const manager = view(attested(), MANAGE);
    expect(ops(manager.container)).toEqual(['ownlist.withdraw']);
    expect(text(manager.container)).toContain('Your role cannot attest the list');
    cleanup();
    const providersOnly = view(attested(), PROVIDERS);
    expect(ops(providersOnly.container)).toEqual([]);
    expect(text(providersOnly.container)).toContain('Your role cannot attest the list');
    expect(text(providersOnly.container)).toContain('Your role cannot withdraw');
    cleanup();
    const nobody = view(attested(), []);
    expect(ops(nobody.container)).toEqual([]);
  });

  it('says a person without the right cannot see the list, and shows a failure without the server’s text', () => {
    const forbidden = view(fail(403, 'forbidden'));
    expect(screen.getByText('You cannot view the own-account list')).toBeTruthy();
    expect(ops(forbidden.container)).toEqual([]);
    cleanup();
    const broken = view(fail(500, 'upstream_internal_detail'));
    expect(screen.getByText('Could not load the own-account list')).toBeTruthy();
    expect(text(broken.container)).not.toContain('upstream_internal_detail');
    expect(ops(broken.container)).toEqual([]);
  });

  it('shows the result of the last action in words, and a refusal with a link to the next step', () => {
    for (const [result, expected] of [
      ['attested', /recorded as attested/],
      ['attestation_withdrawn', /attestation was withdrawn/],
    ] as const) {
      const { container } = view(attested(), VERIFY, { result });
      expect(container.querySelector('[role="status"]')?.textContent).toMatch(expected);
      cleanup();
    }
    const refused = view(notAttested(), VERIFY, { error: 'own_account_list_incomplete' });
    const alert = refused.container.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toMatch(/Register and verify those accounts first/);
    expect(
      within(alert)
        .getByRole('link', { name: 'Open the registered accounts' })
        .getAttribute('href'),
    ).toBe('/accounts');
    expect(alert.textContent).not.toContain('own_account_list_incomplete');
    cleanup();
    for (const error of [
      'forbidden',
      'self_approval',
      'mfa_required',
      'attest_confirm_required',
      'evidence_invalid',
    ]) {
      const { container } = view(attested(), VERIFY, { error });
      expect(container.querySelector('[role="alert"]')?.textContent).not.toContain(error);
      cleanup();
    }
  });

  it('shows no raw code, value or long number, and nothing for an event kind it does not know', () => {
    const { container } = view({
      ok: true,
      status: 200,
      data: ownListState({
        events: [
          ownListEvent(),
          ownListEvent({ id: '0190a000-0000-7000-8000-000000000a09', eventKind: 'attested' }),
        ],
      }),
    });
    expect(text(container).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, 'ID')).not.toMatch(/\d{9,}/);
    expect(text(container)).not.toMatch(/eventKind|keyVersion|entriesCounted|actorId/);
    expect(text(container)).not.toMatch(BANNED);
  });

  it('names the page and each table for screen readers', () => {
    const { container } = view(attested(), ALL_PERMISSIONS);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    for (const table of container.querySelectorAll('table'))
      expect(table.querySelector('caption')).toBeTruthy();
    for (const control of container.querySelectorAll<HTMLInputElement>(
      'input:not([type="hidden"]), textarea',
    ))
      expect(control.labels?.length ?? 0).toBeGreaterThan(0);
    expect(container.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(0);
  });
});

// =====================================================================================================================
describe('Suspended payment configurations and holds', () => {
  const view = (
    configs: Parameters<typeof HoldsPage>[0]['configs'],
    permissions: readonly string[] = PROVIDERS,
    over: Partial<Parameters<typeof HoldsPage>[0]> = {},
    userId = ME,
  ) =>
    render(
      <HoldsPage
        configs={configs}
        lenders={FINANCE}
        query={{}}
        ctx={contextFor(permissions, '/providers/holds', userId)}
        notice={NONE}
        {...over}
      />,
    );

  it('says who held it and since when, in plain words, with the lender by name and the reasons in words', () => {
    const { container } = view(page([paymentConfig()]));
    const words = text(container);
    expect(words).toContain('Sample Finance, provider sample_pay');
    expect(words).toContain(
      'Held by the platform (a member of Udofin staff suspended it with the kill switch), since 18 Oct 2026, 10:00 IST',
    );
    expect(words).toContain('Suspended: not in use');
    expect(words).toContain('The platform team suspended it.');
    expect(words).toContain('Production mode');
    expect(words).not.toMatch(/platform_suspension|holdKind|holdSetAt|statusReasons/);
    cleanup();
    const system = view(
      page([
        paymentConfig({
          id: CONFIG_2,
          holdKind: 'system',
          statusReasons: ['merchant_mismatch'],
          lastValidatedAt: NOW,
          lastValidationOk: false,
        }),
      ]),
    );
    expect(text(system.container)).toContain('Held by the system (the nightly check');
    expect(text(system.container)).toContain('different merchant');
    expect(text(system.container)).toContain('did not pass');
  });

  it('labels a test configuration test only wherever its status is written', () => {
    const { container } = view(page([paymentConfig({ providerMode: 'mock' })]));
    expect(text(container)).toContain('Test only: mock provider');
    expect(text(container)).toContain('Suspended: not in use (test only)');
  });

  it('draws the release form for a provider manager on a hold, with a reason of 10 to 200 characters that is required and empty', () => {
    const { container } = view(page([paymentConfig()]));
    expect(ops(container)).toEqual(['hold.release']);
    const form = container.querySelector('form.form') as HTMLFormElement;
    expect(form.querySelector<HTMLInputElement>('input[name="id"]')?.value).toBe(CONFIG_1);
    expect(form.querySelector<HTMLInputElement>('input[name="returnTo"]')?.value).toBe(
      '/providers/holds',
    );
    expect(form.querySelector<HTMLInputElement>('input[name="key"]')?.value).toMatch(
      /^ui-[0-9a-f-]{36}$/,
    );
    const reason = screen.getByLabelText<HTMLTextAreaElement>('Reason for releasing the hold');
    expect(reason.required).toBe(true);
    expect(reason.value).toBe('');
    expect(reason.maxLength).toBe(200);
    expect(text(form)).toContain('10 to 200 characters, plain text');
    expect(text(form)).toMatch(/does not switch the configuration back on. It stays suspended/);
    expect(text(form)).toMatch(/a different approver at the lender approves it/);
    expect(screen.getByRole('button', { name: 'Release the hold' })).toBeTruthy();
  });

  it('says the rule for each kind of hold before anybody tries, and never claims to know who set a hold', () => {
    const platform = view(page([paymentConfig()]));
    expect(text(platform.container)).toMatch(
      /A hold set by a member of staff can be released only by a different member of staff/,
    );
    expect(text(platform.container)).toMatch(/This page does not say who set it/);
    expect(text(platform.container)).toMatch(
      /If you suspended this configuration yourself, ask a colleague/,
    );
    cleanup();
    const system = view(page([paymentConfig({ holdKind: 'system' })]));
    expect(text(system.container)).toMatch(/any member of staff who may manage providers/);
    expect(text(system.container)).not.toMatch(/only by a different member/);
    cleanup();
    // The same words for the same hold, whoever is looking.
    const other = view(page([paymentConfig()]), PROVIDERS, {}, OTHER);
    expect(text(other.container)).toMatch(/If you suspended this configuration yourself/);
  });

  it('draws no release button without a hold, and says the lender can submit it again', () => {
    const { container } = view(page([paymentConfig({ holdKind: null, holdSetAt: null })]));
    expect(ops(container)).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Release the hold' })).toBeNull();
    expect(text(container)).toContain('Suspended without a hold: the lender can submit it again');
    expect(text(container)).toMatch(
      /There is no hold on this configuration, so there is nothing to release/,
    );
  });

  it('draws no release button for a configuration that is not suspended', () => {
    const { container } = view(page([paymentConfig({ status: 'active' })]));
    expect(ops(container)).toEqual([]);
    expect(text(container)).toMatch(/Only the hold of a suspended configuration can be released/);
  });

  it('draws no release form for a role without the provider right, and says so', () => {
    for (const permissions of [VERIFY, MANAGE, ['platform.features.manage'], []]) {
      const { container } = view(page([paymentConfig()]), permissions);
      expect(ops(container), permissions.join()).toEqual([]);
      expect(text(container)).toContain('Your role cannot release a hold');
      cleanup();
    }
  });

  it('explains the self-approval refusal in a sentence, and does not repeat the code', () => {
    const { container } = view(page([paymentConfig()]), PROVIDERS, {
      notice: { error: 'self_approval' },
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
      /A different person must do this step/,
    );
    expect(text(container)).toMatch(
      /A hold set by a member of staff is released by a different member of staff/,
    );
    expect(text(container)).not.toContain('self_approval');
  });

  it('shows the result of a release in words, and a refusal that names the next step', () => {
    const done = view(page([]), PROVIDERS, { notice: { result: 'hold_released' } });
    expect(done.container.querySelector('[role="status"]')?.textContent).toMatch(
      /The hold was released/,
    );
    cleanup();
    const refused = view(page([]), PROVIDERS, { notice: { error: 'config_state_invalid' } });
    expect(refused.container.querySelector('[role="alert"]')?.textContent).toBe(
      'The payment configuration is not in a state that allows this.',
    );
    cleanup();
    const hold = view(page([]), PROVIDERS, { notice: { error: 'platform_hold' } });
    const alert = hold.container.querySelector('[role="alert"]') as HTMLElement;
    expect(
      within(alert)
        .getByRole('link', { name: 'Open the suspended payment configurations' })
        .getAttribute('href'),
    ).toBe('/providers/holds');
  });

  it('shows none, a failure and a role that cannot read, in words', () => {
    const empty = view(page([]));
    expect(screen.getByText('No suspended payment configuration')).toBeTruthy();
    expect(ops(empty.container)).toEqual([]);
    cleanup();
    const broken = view(fail(500, 'upstream_internal_detail'));
    expect(screen.getByText('Could not load the suspended payment configurations')).toBeTruthy();
    expect(text(broken.container)).not.toContain('upstream_internal_detail');
    cleanup();
    view(fail(403, 'forbidden'), []);
    expect(screen.getByText('You cannot view the suspended payment configurations')).toBeTruthy();
  });

  it('keeps the lender filter in the links to older pages, and names the lender by identifier when the list is missing', () => {
    const { container } = view(page([paymentConfig()], 'next_1'), PROVIDERS, {
      query: { lenderId: LENDER_A },
      lenders: null,
    });
    const link = within(
      container.querySelector('nav[aria-label^="More"]') as HTMLElement,
    ).getByRole('link', {
      name: /Older/,
    });
    expect(link.getAttribute('href')).toBe(`/providers/holds?lenderId=${LENDER_A}&cursor=next_1`);
    expect(text(container)).toContain(`Lender ${LENDER_A}, provider sample_pay`);
  });

  it('shows no secret name, no callback token and no account detail of the configuration', () => {
    const { container } = view(page([paymentConfig()]));
    expect(text(container)).not.toMatch(
      /PSP_ONE|PSP_TWO|secretRef|webhookSecretRef|endpoint|XXXXXX/,
    );
  });

  it('names the page, labels every control and ticks nothing', () => {
    const { container } = view(
      page([paymentConfig(), paymentConfig({ id: CONFIG_2, holdKind: 'system' })]),
    );
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    for (const control of container.querySelectorAll<HTMLInputElement>(
      'input:not([type="hidden"]), select, textarea',
    ))
      expect((control.labels?.length ?? 0) > 0 || control.hasAttribute('aria-label')).toBe(true);
    expect(container.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(0);
    expect(text(container)).not.toMatch(BANNED);
  });
});

// =====================================================================================================================
describe('The hints on the feature-switch page and the links between pages', () => {
  const features = (
    notice: Parameters<typeof FeaturesPage>[0]['notice'] = NONE,
    permissions = ALL_PERMISSIONS,
  ) =>
    render(
      <FeaturesPage
        catalogue={list(CATALOGUE)}
        lenderId={LENDER_A}
        switches={list([])}
        requests={page([])}
        lenders={FINANCE}
        query={{}}
        ctx={contextFor(permissions, '/features')}
        notice={notice}
      />,
    );

  it('says before anybody tries that payments and mandates also need the own-account list, and links to it', () => {
    const { container } = features();
    const cards = [...container.querySelectorAll('article.card')];
    const withNote = cards.filter((card) =>
      /also needs the own-account list to be attested/.test(text(card as HTMLElement)),
    );
    expect(withNote).toHaveLength(2);
    for (const card of withNote) {
      expect(['Payments', 'Mandates']).toContain(card.querySelector('h3')?.textContent);
      expect(card.querySelector('a')?.getAttribute('href')).toBe('/accounts/own-accounts');
    }
  });

  it('tells a refused request what is missing and what to do, with the link to the page that does it', () => {
    const { container } = features({
      error: 'prerequisites_unmet',
      reasons: 'own_account_list_not_attested,payment_config_missing',
    });
    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    const items = [...alert.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toContain(
      'The own-account list has not been attested. Attest it first, on the Own-account list page.',
    );
    expect(items).toContain('There is no active payment configuration in production mode.');
    const links = within(alert).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/accounts/own-accounts']);
    expect(alert.textContent).not.toMatch(/own_account_list|payment_config_missing/);
  });

  it.each([
    ['own_account_list_not_attested', /Attest the list first/, '/accounts/own-accounts'],
    ['own_account_list_incomplete', /Register and verify those accounts first/, '/accounts'],
    ['platform_hold', /Release the hold first/, '/providers/holds'],
    ['active_config_exists', /retires the other one first/, null],
  ])('words the answer %s and names the next step', (error, sentence, href) => {
    const { container } = features({ error });
    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toMatch(sentence);
    expect(alert.textContent).not.toContain(error);
    const links = alert.querySelectorAll('a');
    if (href === null) expect(links).toHaveLength(0);
    else expect(links[0]?.getAttribute('href')).toBe(href);
  });

  it('puts a link only to a fixed page, never to anything taken from the address', () => {
    const { container } = features({
      error: 'prerequisites_unmet',
      reasons: 'https://evil.example,constructor,own_account_list_not_attested',
    });
    for (const a of container.querySelectorAll('[role="alert"] a'))
      expect(['/accounts/own-accounts', '/accounts', '/providers/holds']).toContain(
        a.getAttribute('href'),
      );
    expect(container.innerHTML).not.toContain('evil.example');
  });

  it('adds the own-account list to the registry pages, named in words, and the held configurations to the provider pages', () => {
    const registry = render(
      <RegistryPage
        accounts={page([registryEntry()])}
        registered={null}
        rules={list([approvedRule()])}
        keys={list([keyVersion()])}
        lenders={FINANCE}
        query={{}}
        ctx={contextFor(ALL_PERMISSIONS, '/accounts')}
        notice={NONE}
      />,
    );
    const nav = within(
      registry.container.querySelector('nav[aria-label="Account registry pages"]') as HTMLElement,
    );
    expect(nav.getByRole('link', { name: 'Own-account list' }).getAttribute('href')).toBe(
      '/accounts/own-accounts',
    );
    cleanup();
    const providers = render(
      <ProvidersPage
        providers={list([provider()])}
        returnCodes={list([returnCode()])}
        ctx={contextFor(ALL_PERMISSIONS, '/providers')}
        notice={NONE}
      />,
    );
    const pages = within(
      providers.container.querySelector('nav[aria-label="Provider pages"]') as HTMLElement,
    );
    expect(
      pages.getByRole('link', { name: 'Providers and return codes' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(
      pages.getByRole('link', { name: 'Suspended payment configurations' }).getAttribute('href'),
    ).toBe('/providers/holds');
    cleanup();
    const holds = render(
      <HoldsPage
        configs={page([])}
        lenders={FINANCE}
        query={{}}
        ctx={contextFor(PROVIDERS, '/providers/holds')}
        notice={NONE}
      />,
    );
    const here = within(
      holds.container.querySelector('nav[aria-label="Provider pages"]') as HTMLElement,
    );
    expect(
      here
        .getByRole('link', { name: 'Suspended payment configurations' })
        .getAttribute('aria-current'),
    ).toBe('page');
  });
});
