import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { errorKey } from '../../src/borrower/errors';
import { formatDate } from '../../src/borrower/format';
import { stageKey } from '../../src/borrower/routing';
import { useLoad } from '../../src/borrower/useLoad';
import { useBorrower } from '../../src/borrower/BorrowerProvider';
import { type MessageKey } from '../../src/i18n';
import { useI18n } from '../../src/i18n/I18nProvider';
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
} from '../../src/ui/kit';

/** One card per lender: where its process stands, exactly as the lender reports it. A missing answer is never shown as a decline. */
export default function ApplicationsScreen() {
  const router = useRouter();
  const { request } = useLocalSearchParams<{ request?: string }>();
  const requestId = request ?? '';
  const { t, language } = useI18n();
  const { client } = useBorrower();
  const { state, reload } = useLoad(() => client.applications(requestId), [client, requestId]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.kind === 'loading') return <Loading label={t('common.loading')} />;
  if (state.kind === 'error')
    return (
      <ScrollScreen>
        <Heading>{t('apps.title')}</Heading>
        <ErrorState
          message={t(errorKey(state.code))}
          retryLabel={t('common.retry')}
          onRetry={reload}
        />
      </ScrollScreen>
    );

  async function withdraw(id: string) {
    setBusy(true);
    setError(null);
    const result = await client.withdrawApplication(id);
    setBusy(false);
    setConfirming(null);
    if (!result.ok) setError(t(errorKey(result.code)));
    reload();
  }

  const items = state.data.items;
  return (
    <ScrollScreen>
      <Heading>{t('apps.title')}</Heading>
      {items.length === 0 ? <Banner tone="info">{t('apps.empty')}</Banner> : null}
      {items.map((a) => (
        <Card key={a.applicationId}>
          <Label>{a.lenderName}</Label>
          <Body muted>{a.productName}</Body>
          <Body>{t(stageKey(a.stage))}</Body>
          {a.stage === 'no_response' ||
          a.stage === 'sent' ||
          a.stage === 'acknowledged' ||
          a.stage === 'processing' ? (
            <Body muted>{t('apps.dueBy', { date: formatDate(a.responseDueAt, language) })}</Body>
          ) : null}
          {a.stage === 'no_response' ? <Body muted>{t('apps.noDecisionNote')}</Body> : null}
          {a.checks.length > 0 ? (
            <>
              {a.checks.map((c) => (
                <Body key={c.kind} muted>
                  {`${t(`check.${c.kind}` as MessageKey)}: ${t(`check.status.${c.status}` as MessageKey)}`}
                </Body>
              ))}
              <Body muted>{t('check.reportedByLender')}</Body>
            </>
          ) : null}
          {a.stage !== 'withdrawn' && a.stage !== 'stopped' && a.stage !== 'declined' ? (
            confirming === a.applicationId ? (
              <>
                <Banner tone="warning">{t('apps.withdrawConfirm')}</Banner>
                <Button
                  title={t('requests.withdrawYes')}
                  busy={busy}
                  onPress={() => void withdraw(a.applicationId)}
                />
                <Button title={t('common.cancel')} secondary onPress={() => setConfirming(null)} />
              </>
            ) : (
              <Button
                title={t('apps.withdraw')}
                secondary
                onPress={() => setConfirming(a.applicationId)}
              />
            )
          ) : null}
        </Card>
      ))}
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <Button
        title={t('apps.compare')}
        onPress={() => router.push({ pathname: '/offers', params: { request: requestId } })}
      />
      <Button
        title={t('apps.chooseLenders')}
        secondary
        onPress={() => router.push({ pathname: '/lenders', params: { request: requestId } })}
      />
    </ScrollScreen>
  );
}
