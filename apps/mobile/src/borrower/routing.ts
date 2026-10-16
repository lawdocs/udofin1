import {
  type APPLICATION_STAGES,
  type MatchingLender,
  type SelectionView,
  MAX_LENDERS_PER_REQUEST,
} from '@udofin/contracts';
import { type MessageKey } from '../i18n';

export interface LenderChoice {
  lenderId: string;
  lenderName: string;
  products: MatchingLender[];
}

/** Groups the matching list by lender. Several products of one lender stay together: one product per lender per request. */
export function groupByLender(items: readonly MatchingLender[]): LenderChoice[] {
  const map = new Map<string, LenderChoice>();
  for (const item of items) {
    const entry = map.get(item.lenderId) ?? {
      lenderId: item.lenderId,
      lenderName: item.lenderName,
      products: [],
    };
    entry.products.push(item);
    map.set(item.lenderId, entry);
  }
  return [...map.values()].sort((a, b) => a.lenderName.localeCompare(b.lenderName));
}

/** lenderId -> chosen product version (null: not chosen yet). Empty to start: no lender is ever preselected. */
export type Chosen = Readonly<Record<string, string | null>>;

export function toggleLender(
  chosen: Chosen,
  lenderId: string,
  max: number = MAX_LENDERS_PER_REQUEST,
): Chosen {
  if (lenderId in chosen) {
    return Object.fromEntries(Object.entries(chosen).filter(([id]) => id !== lenderId));
  }
  if (Object.keys(chosen).length >= max) return chosen; // the server enforces the same limit
  return { ...chosen, [lenderId]: null };
}

export function setProduct(chosen: Chosen, lenderId: string, versionId: string): Chosen {
  return lenderId in chosen ? { ...chosen, [lenderId]: versionId } : chosen;
}

export type PayloadResult =
  | { ok: true; items: { lenderId: string; productVersionId?: string }[] }
  | { ok: false; reason: 'empty' | 'product_required' };

export function selectionPayload(chosen: Chosen, groups: readonly LenderChoice[]): PayloadResult {
  const entries = Object.entries(chosen);
  if (entries.length === 0) return { ok: false, reason: 'empty' };
  const items: { lenderId: string; productVersionId?: string }[] = [];
  for (const [lenderId, versionId] of entries) {
    const group = groups.find((g) => g.lenderId === lenderId);
    if (!group) continue;
    if (versionId) items.push({ lenderId, productVersionId: versionId });
    else if (group.products.length === 1) items.push({ lenderId });
    else return { ok: false, reason: 'product_required' };
  }
  return items.length === 0 ? { ok: false, reason: 'empty' } : { ok: true, items };
}

export type Blocker = 'wording_missing' | 'wording_unapproved' | 'consent_missing';

/** Whether the request can be sent now, and what is in the way for each lender. Sending needs every chosen lender's own consent. */
export function routeReadiness(view: SelectionView): {
  ready: boolean;
  blockers: { lenderId: string; blocker: Blocker }[];
} {
  const blockers: { lenderId: string; blocker: Blocker }[] = [];
  const open = view.items.filter((i) => i.status !== 'removed');
  for (const item of open) {
    if (item.notice === null)
      blockers.push({ lenderId: item.lenderId, blocker: 'wording_missing' });
    else if (item.notice.reviewStatus !== 'approved')
      blockers.push({ lenderId: item.lenderId, blocker: 'wording_unapproved' });
    else if (!item.consentInForce)
      blockers.push({ lenderId: item.lenderId, blocker: 'consent_missing' });
  }
  return { ready: open.length > 0 && blockers.length === 0, blockers };
}

type Stage = (typeof APPLICATION_STAGES)[number];
export const stageKey = (stage: Stage): MessageKey => `stage.${stage}` as MessageKey;

/** Formats a lender-supplied APR in basis points for display (2050 -> 20.50%). Display only: nothing is calculated from it. */
export function formatAprBps(bps: number): string {
  const whole = Math.floor(bps / 100);
  const fraction = String(bps % 100).padStart(2, '0');
  return `${String(whole)}.${fraction}%`;
}

/**
 * A last check before opening a KFS link: https only, no embedded credentials, no odd characters. The server has already
 * required the host to be registered for the lender; this only guards the device.
 */
export function isSafeKfsUrl(url: string): boolean {
  if (url.length > 2048 || /[\s\\]/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.hostname.includes('.')
    );
  } catch {
    return false;
  }
}
