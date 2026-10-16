import { type LoanRequest } from '@udofin/contracts';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { errorKey } from '../../../src/borrower/errors';
import { expiryState } from '../../../src/borrower/expiry';
import { formatDate } from '../../../src/borrower/format';
import { formatRupees } from '../../../src/borrower/money';
import { useBorrower } from '../../../src/borrower/BorrowerProvider';
import { useLoad } from '../../../src/borrower/useLoad';
import { type MessageKey } from '../../../src/i18n';
import { useI18n } from '../../../src/i18n/I18nProvider';
import {
  Banner,
  Body,
  Button,
  Card,
  ErrorState,
  Heading,
  Label,
  Loading,
  ScrollScreen,
} from '../../../src/ui/kit';

/** The borrower's own requests, newest first. Statuses are exactly what the server holds. */
export default function RequestsScreen() {
  const router = useRouter();
  const { t, language } = useI18n();
  const { client } = useBorrower();
  const first = useLoad(() => client.listRequests(), [client]);
  const [extra, setExtra] = useState<{ items: LoanRequest[]; cursor: string | null } | null>(null);
  const [more, setMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  if (first.state.kind === 'loading') return <Loading label={t('common.loading')} />;
  if (first.state.kind === 'error')
    return (
      <ScrollScreen>
        <Heading>{t('requests.title')}</Heading>
        <ErrorState
          message={t(errorKey(first.state.code))}
          retryLabel={t('common.retry')}
          onRetry={() => {
            setExtra(null);
            first.reload();
          }}
        />
      </ScrollScreen>
    );

  const items = [...first.state.data.items, ...(extra?.items ?? [])];
  const cursor = extra ? extra.cursor : first.state.data.nextCursor;

  async function loadMore(after: string) {
    setMore(true);
    setMoreError(null);
    const result = await client.listRequests(after);
    setMore(false);
    if (!result.ok) return setMoreError(t(errorKey(result.code)));
    setExtra({
      items: [...(extra?.items ?? []), ...result.data.items],
      cursor: result.data.nextCursor,
    });
  }

  return (
    <ScrollScreen>
      <Heading>{t('requests.title')}</Heading>
      {items.length === 0 ? <Banner tone="info">{t('requests.empty')}</Banner> : null}
      {items.map((r) => {
        const expiry = expiryState(r.status, r.expiresAt);
        return (
          <Card key={r.id}>
            <Label>{t(`requests.status.${r.status}` as MessageKey)}</Label>
            <Body>{t('requests.amount', { amount: formatRupees(r.amountMinor) })}</Body>
            <Body muted>{t('requests.created', { date: formatDate(r.createdAt, language) })}</Body>
            {r.submissionReference ? (
              <Body muted>{t('requests.reference', { ref: r.submissionReference })}</Body>
            ) : null}
            {expiry.kind === 'soon' ? (
              <Banner tone="warning">
                {t('requests.expiryWarning', {
                  days: expiry.days,
                  date: formatDate(r.expiresAt ?? '', language),
                })}
              </Banner>
            ) : null}
            {expiry.kind === 'today' ? (
              <Banner tone="warning">
                {t('requests.expiryWarningToday', {
                  date: formatDate(r.expiresAt ?? '', language),
                })}
              </Banner>
            ) : null}
            <Button
              title={t('requests.detail.title')}
              secondary
              onPress={() => router.push({ pathname: '/requests/[id]', params: { id: r.id } })}
            />
          </Card>
        );
      })}
      {moreError ? <Banner tone="danger">{moreError}</Banner> : null}
      {cursor ? (
        <Button
          title={t('requests.loadMore')}
          secondary
          busy={more}
          onPress={() => void loadMore(cursor)}
        />
      ) : null}
    </ScrollScreen>
  );
}
