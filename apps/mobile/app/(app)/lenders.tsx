import { type MatchingLender } from '@udofin/contracts';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { useBorrower } from '../../src/borrower/BorrowerProvider';
import { errorKey } from '../../src/borrower/errors';
import { newIdempotencyKey } from '../../src/borrower/form';
import { formatRupees } from '../../src/borrower/money';
import {
  groupByLender,
  routeReadiness,
  selectionPayload,
  setProduct,
  toggleLender,
  type Chosen,
} from '../../src/borrower/routing';
import { daysToMonths } from '../../src/borrower/tenure';
import { useLoad } from '../../src/borrower/useLoad';
import { useI18n } from '../../src/i18n/I18nProvider';
import {
  Banner,
  Body,
  Button,
  Card,
  CheckRow,
  Choice,
  ErrorState,
  Heading,
  Label,
  Loading,
  ScrollScreen,
} from '../../src/ui/kit';

const APP_VERSION = '0.1.0';
const lenderError = (code: string) =>
  code === 'consent_required' ? 'error.consentMissing' : errorKey(code);

/**
 * Step 1: choose lenders (none preselected, at most five). Step 2: read each lender's own wording and agree for that
 * lender separately. Step 3: send. The server re-checks everything (limit, consent, wording approval, product) so this
 * screen only guides.
 */
export default function LendersScreen() {
  const router = useRouter();
  const { request } = useLocalSearchParams<{ request?: string }>();
  const requestId = request ?? '';
  const { t, language } = useI18n();
  const { client, refresh } = useBorrower();
  const matching = useLoad(() => client.matchingLenders(requestId), [client, requestId]);
  const selection = useLoad(
    () => client.selection(requestId, language),
    [client, requestId, language],
  );
  const [chosen, setChosen] = useState<Chosen>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [editing, setEditing] = useState(false);
  const [routeKey, setRouteKey] = useState<string | null>(null);

  const groups = useMemo(
    () => (matching.state.kind === 'ready' ? groupByLender(matching.state.data.items) : []),
    [matching.state],
  );

  if (!requestId) return <Loading label={t('common.loading')} />;
  if (matching.state.kind === 'loading' || selection.state.kind === 'loading')
    return <Loading label={t('common.loading')} />;
  if (matching.state.kind === 'error' || selection.state.kind === 'error') {
    const code =
      matching.state.kind === 'error'
        ? matching.state.code
        : selection.state.kind === 'error'
          ? selection.state.code
          : 'generic';
    return (
      <ScrollScreen>
        <Heading>{t('lenders.title')}</Heading>
        <ErrorState
          message={t(lenderError(code))}
          retryLabel={t('common.retry')}
          onRetry={() => {
            matching.reload();
            selection.reload();
          }}
        />
      </ScrollScreen>
    );
  }

  const view = selection.state.data;
  const hasSelection = view.selectionId !== null;
  const max = view.maxLenders;
  const readiness = routeReadiness(view);

  async function saveSelection() {
    const payload = selectionPayload(chosen, groups);
    if (!payload.ok)
      return setError(
        t(payload.reason === 'product_required' ? 'lenders.productRequired' : 'lenders.none'),
      );
    setBusy('select');
    setError(null);
    const result = await client.selectLenders(requestId, payload.items);
    setBusy(null);
    if (!result.ok) return setError(t(lenderError(result.code)));
    setEditing(false);
    selection.reload();
  }

  async function decide(lenderId: string, noticeId: string, decision: 'granted' | 'withdrawn') {
    setBusy(lenderId);
    setError(null);
    const result = await client.lenderConsent(requestId, {
      lenderId,
      noticeId,
      decision,
      appVersion: APP_VERSION,
    });
    setBusy(null);
    if (!result.ok) setError(t(lenderError(result.code)));
    selection.reload();
  }

  async function remove(lenderId: string) {
    if (!view.selectionId) return;
    setBusy(lenderId);
    const result = await client.removeSelected(view.selectionId, lenderId);
    setBusy(null);
    if (!result.ok) setError(t(lenderError(result.code)));
    setChosen((c) => Object.fromEntries(Object.entries(c).filter(([id]) => id !== lenderId)));
    selection.reload();
  }

  async function send() {
    if (!view.selectionId) return;
    setBusy('route');
    setError(null);
    // A retry after a lost answer reuses the key, so the same selection is sent once.
    const key = routeKey ?? newIdempotencyKey();
    setRouteKey(key);
    const result = await client.routeSelection(view.selectionId, key);
    setBusy(null);
    if (!result.ok) {
      if (result.code !== 'network_error') setRouteKey(null);
      return setError(t(lenderError(result.code)));
    }
    await refresh();
    setSent(true);
  }

  if (sent) {
    return (
      <ScrollScreen>
        <Heading>{t('lenders.title')}</Heading>
        <Banner tone="info">{t('lenders.sent')}</Banner>
        <Button
          title={t('lenders.viewStatus')}
          onPress={() =>
            router.replace({ pathname: '/applications', params: { request: requestId } })
          }
        />
      </ScrollScreen>
    );
  }

  return (
    <ScrollScreen>
      <Heading>{t('lenders.title')}</Heading>
      <Body muted>{t('lenders.intro')}</Body>
      <Banner tone="info">{t('lenders.shared')}</Banner>

      {!hasSelection || editing ? (
        <>
          {groups.length === 0 ? <Banner tone="warning">{t('lenders.none')}</Banner> : null}
          <Body muted>{t('lenders.count', { max, n: Object.keys(chosen).length })}</Body>
          {groups.map((g) => {
            const checked = g.lenderId in chosen;
            return (
              <Card key={g.lenderId}>
                <CheckRow
                  label={g.lenderName}
                  checked={checked}
                  onToggle={() => setChosen((c) => toggleLender(c, g.lenderId))}
                />
                {checked && g.products.length > 1 ? (
                  <>
                    <Label>{t('lenders.chooseProduct')}</Label>
                    {g.products.map((p: MatchingLender) => (
                      <Choice
                        key={p.versionId}
                        label={p.productName}
                        detail={t('request.productRange', {
                          min: formatRupees(p.minAmountMinor),
                          max: formatRupees(p.maxAmountMinor),
                          minMonths: daysToMonths(p.minTenureDays),
                          maxMonths: daysToMonths(p.maxTenureDays),
                        })}
                        selected={chosen[g.lenderId] === p.versionId}
                        onPress={() => setChosen((c) => setProduct(c, g.lenderId, p.versionId))}
                      />
                    ))}
                  </>
                ) : null}
                {checked && g.products.length === 1 ? (
                  <Body muted>{g.products[0]?.productName}</Body>
                ) : null}
              </Card>
            );
          })}
          {Object.keys(chosen).length >= max ? (
            <Banner tone="info">{t('lenders.limit', { max })}</Banner>
          ) : null}
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Button
            title={t('lenders.next')}
            busy={busy === 'select'}
            disabled={Object.keys(chosen).length === 0}
            onPress={() => void saveSelection()}
          />
        </>
      ) : (
        <>
          {view.items
            .filter((i) => i.status !== 'removed')
            .map((item) => (
              <Card key={item.lenderId}>
                <Label>{item.lenderName}</Label>
                <Body muted>{item.productName}</Body>
                {item.notice === null ? (
                  <Banner tone="warning">{t('lenders.wordingMissing')}</Banner>
                ) : null}
                {item.notice && item.notice.reviewStatus !== 'approved' ? (
                  <Banner tone="warning">{t('lenders.wordingUnapproved')}</Banner>
                ) : null}
                {item.notice?.languageFallback ? (
                  <Banner tone="info">{t('common.languageFallback')}</Banner>
                ) : null}
                {item.notice ? (
                  <>
                    <Button
                      title={open === item.lenderId ? t('consent.hide') : t('consent.read')}
                      secondary
                      onPress={() => setOpen(open === item.lenderId ? null : item.lenderId)}
                    />
                    {open === item.lenderId ? <Body>{item.notice.bodyMarkdown}</Body> : null}
                    <Body muted>{t('consent.version', { version: item.notice.version })}</Body>
                  </>
                ) : null}
                {item.consentInForce ? (
                  <>
                    <Body>{t('lenders.consentGranted', { lender: item.lenderName })}</Body>
                    {item.notice ? (
                      <Button
                        title={t('lenders.withdraw')}
                        secondary
                        busy={busy === item.lenderId}
                        onPress={() =>
                          void decide(item.lenderId, item.notice?.id ?? '', 'withdrawn')
                        }
                      />
                    ) : null}
                  </>
                ) : item.notice && item.notice.reviewStatus === 'approved' ? (
                  <CheckRow
                    label={t('lenders.consentFor', { lender: item.lenderName })}
                    checked={false}
                    disabled={busy === item.lenderId}
                    onToggle={() => void decide(item.lenderId, item.notice?.id ?? '', 'granted')}
                  />
                ) : null}
                <Button
                  title={t('lenders.remove')}
                  secondary
                  onPress={() => void remove(item.lenderId)}
                />
              </Card>
            ))}
          <Button title={t('apps.chooseLenders')} secondary onPress={() => setEditing(true)} />
          {!readiness.ready ? <Banner tone="warning">{t('lenders.notReady')}</Banner> : null}
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Button
            title={
              busy === 'route'
                ? t('lenders.sending')
                : t('lenders.send', { n: view.items.filter((i) => i.status !== 'removed').length })
            }
            busy={busy === 'route'}
            disabled={!readiness.ready || busy !== null}
            onPress={() => void send()}
          />
        </>
      )}
    </ScrollScreen>
  );
}
