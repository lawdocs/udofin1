import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APPLICATION_STATUSES,
  APPLICATION_TRANSITIONS,
  applicationLifecycle,
  canActorTransition,
} from '../src/lifecycles/application.js';

const migration = readFileSync(
  fileURLToPath(
    new URL('../../../supabase/migrations/20261010000400_lending_core.sql', import.meta.url),
  ),
  'utf8',
);

function sqlStatuses(): string[] {
  const match = /create type lending\.application_status as enum \(([^;]+)\);/.exec(migration);
  if (!match?.[1]) throw new Error('application_status enum not found in migration');
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '');
}

function sqlTransitions(): string[] {
  const block = /insert into lending\.application_transitions[^;]*values([\s\S]+?);/.exec(
    migration,
  )?.[1];
  if (!block) throw new Error('application_transitions seed not found in migration');
  return [...block.matchAll(/\('([a-z_]+)', '([a-z_]+)', array\[([^\]]+)\]\)/g)].map((m) => {
    const actors = [...(m[3] ?? '').matchAll(/'([a-z]+)'/g)].map((a) => a[1]).sort();
    return `${m[1]}->${m[2]}:${actors.join(',')}`;
  });
}

describe('application lifecycle', () => {
  it('declares exactly the statuses the database enum declares', () => {
    expect([...APPLICATION_STATUSES]).toEqual(sqlStatuses());
  });

  it('matches the database transition table, including who may act', () => {
    const domain = APPLICATION_TRANSITIONS.map(
      ([from, to, actors]) => `${from}->${to}:${[...actors].sort().join(',')}`,
    );
    expect(domain.sort()).toEqual(sqlTransitions().sort());
  });

  it('never lets anyone but the system record a disbursement', () => {
    expect(canActorTransition('system', 'disbursement_pending', 'disbursed')).toBe(true);
    expect(canActorTransition('lender', 'disbursement_pending', 'disbursed')).toBe(false);
    expect(canActorTransition('borrower', 'disbursement_pending', 'disbursed')).toBe(false);
  });

  it('never lets a borrower approve or a lender accept', () => {
    expect(canActorTransition('borrower', 'under_review', 'approved')).toBe(false);
    expect(canActorTransition('lender', 'approved', 'offer_accepted')).toBe(false);
  });

  it('cannot jump from approval to disbursement', () => {
    expect(applicationLifecycle.canTransition('approved', 'disbursed')).toBe(false);
    expect(applicationLifecycle.isTerminal('disbursed')).toBe(true);
  });
});
