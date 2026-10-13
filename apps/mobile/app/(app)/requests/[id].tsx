import { useLocalSearchParams, useRouter } from 'expo-router';
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

/** One request with its history. Only events the server recorded are shown; nothing is inferred or invented. */
export default function RequestDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, language } = useI18n();
  const { client, refresh } = useBorrower();
  const { state, reload } = useLoad(() => client.request(id), [client, id]);
  const purposes = useLoad(() => client.purposes(language), [client, language]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.kind === 'loading') return <Loading label={t('common.loading')} />;
  if (state.kind === 'error')
    return (
      <ScrollScreen>
        <Heading>{t('requests.detail.title')}</Heading>
        <ErrorState
          message={t(errorKey(state.code))}
          retryLabel={t('common.retry')}
          onRetry={reload}
        />
        <Button title={t('common.back')} secondary onPress={() => router.back()} />
      </ScrollScreen>
    );

  const { request: r, events } = state.data;
  const expiry = expiryState(r.status, r.expiresAt);
  const purposeLabel =
    purposes.state.kind === 'ready'
      ? (purposes.state.data.items.find((p) => p.key === r.purposeCode)?.label ?? r.purposeCode)
      : r.purposeCode;

  async function withdraw() {
    setBusy(true);
    setError(null);
    const result = await client.withdraw(r.id, r.version);
    setBusy(false);
    setConfirming(false);
    if (!result.ok) setError(t(errorKey(result.code)));
    await refresh();
    reload();
  }

  return (
    <ScrollScreen>
      <Heading>{t('requests.detail.title')}</Heading>
      <Card>
        <Label>{t(`requests.status.${r.status}` as MessageKey)}</Label>
        {r.submissionReference ? (
          <Body>{t('requests.reference', { ref: r.submissionReference })}</Body>
        ) : null}
        <Body>{t('requests.amount', { amount: formatRupees(r.amountMinor) })}</Body>
        <Body>{t('requests.tenure', { days: r.tenureDays })}</Body>
        <Body>{t('requests.purpose', { purpose: purposeLabel })}</Body>
        <Body muted>{t('requests.created', { date: formatDate(r.createdAt, language) })}</Body>
        {r.status === 'draft' && r.expiresAt ? (
          <Body muted>{t('requests.expires', { date: formatDate(r.expiresAt, language) })}</Body>
        ) : null}
      </Card>
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
          {t('requests.expiryWarningToday', { date: formatDate(r.expiresAt ?? '', language) })}
        </Banner>
      ) : null}
      {expiry.kind === 'expired' ? <Banner tone="info">{t('requests.expired')}</Banner> : null}

      <Label>{t('requests.history')}</Label>
      {events.map((e) => (
        <Body key={`${e.event}-${e.occurredAt}`} muted>
          {`${formatDate(e.occurredAt, language)}: ${t(`requests.event.${e.event}` as MessageKey)}`}
        </Body>
      ))}

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {r.status === 'draft' ? (
        <Button
          title={t('requests.edit')}
          onPress={() => router.push({ pathname: '/new-request', params: { draft: r.id } })}
        />
      ) : null}
      {r.status === 'draft' || r.status === 'submitted' ? (
        confirming ? (
          <>
            <Banner tone="warning">{t('requests.withdrawConfirm')}</Banner>
            <Button title={t('requests.withdrawYes')} busy={busy} onPress={() => void withdraw()} />
            <Button title={t('common.cancel')} secondary onPress={() => setConfirming(false)} />
          </>
        ) : (
          <Button title={t('requests.withdraw')} secondary onPress={() => setConfirming(true)} />
        )
      ) : null}
      <Button title={t('common.back')} secondary onPress={() => router.back()} />
    </ScrollScreen>
  );
}
