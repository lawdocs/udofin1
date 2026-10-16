import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MANDATE_DEBIT_RANKS,
  MANDATE_LIVE_STATUSES,
  MANDATE_STATUSES,
  MANDATE_TRANSITIONS,
  canActorMoveMandate,
  mandateLifecycle,
} from '../src/lifecycles/mandate.js';

const migration = readFileSync(
  fileURLToPath(
    new URL('../../../supabase/migrations/20261018000915_p08a_mandates.sql', import.meta.url),
  ),
  'utf8',
);

function sqlStatuses(): string[] {
  const match =
    /create table payments\.mandates \([\s\S]*?status text not null default 'draft' check \(status in \(([^)]+)\)\)/.exec(
      migration,
    );
  if (!match?.[1]) throw new Error('mandate status check not found in migration');
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '');
}

function sqlTransitions(): string[] {
  const block = /insert into payments\.mandate_transitions[^;]*values([\s\S]+?);/.exec(
    migration,
  )?.[1];
  if (!block) throw new Error('mandate_transitions seed not found in migration');
  return [...block.matchAll(/\('([a-z_]+)', '([a-z_]+)', array\[([^\]]+)\]\)/g)].map((m) => {
    const actors = [...(m[3] ?? '').matchAll(/'([a-z]+)'/g)].map((a) => a[1]).sort();
    return `${m[1]}->${m[2]}:${actors.join(',')}`;
  });
}

function sqlDebitRanks(): Record<string, number> {
  const match =
    /create or replace function private\.debit_rank[\s\S]*?case p_status([\s\S]*?) end::smallint/.exec(
      migration,
    );
  if (!match?.[1]) throw new Error('debit_rank not found in migration');
  return Object.fromEntries(
    [...match[1].matchAll(/when '([a-z_]+)' then (\d+)/g)].map((m) => [m[1] ?? '', Number(m[2])]),
  );
}

describe('mandate lifecycle', () => {
  it('declares exactly the statuses the database declares', () => {
    expect([...MANDATE_STATUSES].sort()).toEqual(sqlStatuses().sort());
  });

  it('matches the database transition table, including who may act', () => {
    const domain = MANDATE_TRANSITIONS.map(
      ([from, to, actors]) => `${from}->${to}:${[...actors].sort().join(',')}`,
    );
    expect(domain.sort()).toEqual(sqlTransitions().sort());
  });

  it('has the same forward-only debit ranks as the database', () => {
    expect(MANDATE_DEBIT_RANKS).toEqual(sqlDebitRanks());
  });

  it('lets nobody but the system move a mandate', () => {
    for (const [from, to] of MANDATE_TRANSITIONS) {
      expect(canActorMoveMandate('system', from, to)).toBe(true);
      expect(canActorMoveMandate('borrower', from, to)).toBe(false);
      expect(canActorMoveMandate('lender', from, to)).toBe(false);
    }
  });

  it('never activates a mandate from the draft: a provider answer must come first', () => {
    expect(mandateLifecycle.canTransition('draft', 'active')).toBe(false);
    expect(mandateLifecycle.canTransition('draft', 'registration_pending')).toBe(true);
    expect(mandateLifecycle.canTransition('registration_pending', 'active')).toBe(true);
  });

  it('has no way out of a finished mandate', () => {
    for (const finished of ['rejected', 'failed', 'expired', 'cancelled', 'revoked'] as const) {
      expect(mandateLifecycle.isTerminal(finished)).toBe(true);
      expect(MANDATE_LIVE_STATUSES).not.toContain(finished);
    }
  });

  it('keeps the live statuses in line with the one-live-mandate-per-loan index', () => {
    const match =
      /create unique index mandates_one_live_per_loan[\s\S]*?where status in \(([^)]+)\)/.exec(
        migration,
      );
    const live = [...(match?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '');
    expect([...MANDATE_LIVE_STATUSES].sort()).toEqual(live.sort());
  });
});
