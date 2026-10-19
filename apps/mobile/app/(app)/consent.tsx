import { type Notice } from '@udofin/contracts';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useBorrower } from '../../src/borrower/BorrowerProvider';
import { errorKey } from '../../src/borrower/errors';
import { formatDate } from '../../src/borrower/format';
import { useLoad } from '../../src/borrower/useLoad';
import { type MessageKey } from '../../src/i18n';
import { useI18n } from '../../src/i18n/I18nProvider';
import {
  Banner,
  Body,
  Button,
  Card,
  CheckRow,
  ErrorState,
  Heading,
  Label,
  Loading,
  ScrollScreen,
} from '../../src/ui/kit';

const APP_VERSION = '0.1.0';

/**
 * One card per consent, each separate and unticked by default. The wording shown is the exact published
 * version; its id is what gets recorded. Marketing is not offered while it is disabled.
 */
export default function ConsentScreen() {
  const router = useRouter();
  const { t, language } = useI18n();
  const { client, meState, refresh, changeLanguage } = useBorrower();
  const { state, reload } = useLoad(() => client.notices(language), [client, language]);
  const [open, setOpen] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (state.kind === 'loading' || meState.kind === 'loading')
    return <Loading label={t('common.loading')} />;
  if (state.kind === 'error' || meState.kind === 'error') {
    const code =
      state.kind === 'error' ? state.code : meState.kind === 'error' ? meState.code : 'generic';
    return (
      <ScrollScreen>
        <ErrorState
          message={t(errorKey(code))}
          retryLabel={t('common.retry')}
          onRetry={() => {
            reload();
            void refresh();
          }}
        />
      </ScrollScreen>
    );
  }

  const me = meState.me;
  const stateOf = (n: Notice) => me.consents.find((c) => c.purpose === n.purpose);
  const agreed = (n: Notice) => {
    const c = stateOf(n);
    return c?.decision === 'granted' && c.noticeVersion === n.version;
  };
  const missing = state.data.items.filter((n) => n.required && !agreed(n));

  async function decide(n: Notice, decision: 'granted' | 'withdrawn') {
    setBusyId(n.id);
    setError(null);
    const result = await client.decide(n.id, decision, APP_VERSION);
    if (!result.ok) setError(t(errorKey(result.code)));
    await refresh();
    setBusyId(null);
  }

  return (
    <ScrollScreen>
      <Heading>{t('consent.title')}</Heading>
      <Body muted>{t('consent.intro')}</Body>
      {state.data.items.length === 0 ? <Banner tone="warning">{t('consent.empty')}</Banner> : null}
      {state.data.items.map((n) => {
        const current = stateOf(n);
        const isAgreed = agreed(n);
        const expanded = open === n.id;
        const label = t(`consent.purpose.${n.purpose}` as MessageKey);
        return (
          <Card key={n.id}>
            <Label>{label}</Label>
            {n.required ? <Body muted>{t('consent.required')}</Body> : null}
            {n.reviewStatus === 'requires_review' ? (
              <Banner tone="warning">{t('common.requiresReview')}</Banner>
            ) : null}
            {n.languageFallback ? (
              <Banner tone="info">{t('common.languageFallback')}</Banner>
            ) : null}
            <Button
              title={expanded ? t('consent.hide') : t('consent.read')}
              secondary
              onPress={() => setOpen(expanded ? null : n.id)}
            />
            {expanded ? <Body>{n.bodyMarkdown}</Body> : null}
            <Body muted>{t('consent.version', { version: n.version })}</Body>
            {isAgreed && current ? (
              <>
                <Body>
                  {t('consent.agreed', { date: formatDate(current.capturedAt, language) })}
                </Body>
                <Button
                  title={t('consent.withdraw')}
                  secondary
                  busy={busyId === n.id}
                  onPress={() => void decide(n, 'withdrawn')}
                />
              </>
            ) : (
              <>
                {current?.decision === 'withdrawn' ? (
                  <Body>
                    {t('consent.withdrawn', { date: formatDate(current.capturedAt, language) })}
                  </Body>
                ) : null}
                {n.reviewStatus === 'requires_review' ? (
                  <>
                    <Banner tone="warning">{t('consent.reviewBlocked')}</Banner>
                    <Button
                      title={t('consent.useEnglish')}
                      secondary
                      onPress={() => void changeLanguage('en')}
                    />
                  </>
                ) : (
                  <CheckRow
                    label={`${t('consent.accept')}: ${label}`}
                    checked={false}
                    disabled={busyId === n.id}
                    onToggle={() => void decide(n, 'granted')}
                  />
                )}
              </>
            )}
          </Card>
        );
      })}
      <Body muted>{t('consent.marketingOff')}</Body>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {missing.length === 0 && state.data.items.length > 0 ? (
        <>
          <Banner tone="info">{t('consent.allDone')}</Banner>
          <Button title={t('common.continue')} onPress={() => router.replace('/')} />
        </>
      ) : missing.length > 0 ? (
        <Banner tone="warning">
          {t('consent.missing', {
            list: missing.map((n) => t(`consent.purpose.${n.purpose}` as MessageKey)).join(', '),
          })}
        </Banner>
      ) : null}
    </ScrollScreen>
  );
}
