import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useAuth } from '../../../src/auth/AuthProvider';
import { errorKey } from '../../../src/borrower/errors';
import { useBorrower } from '../../../src/borrower/BorrowerProvider';
import { useLoad } from '../../../src/borrower/useLoad';
import { type MessageKey } from '../../../src/i18n';
import { useI18n } from '../../../src/i18n/I18nProvider';
import {
  Banner,
  Body,
  Button,
  CheckRow,
  ErrorState,
  Heading,
  Loading,
  ScrollScreen,
} from '../../../src/ui/kit';

/**
 * Two steps: read what happens, then confirm. The worker anonymises the profile; records the law and the
 * lender require are kept (no retention period is invented here). Sign-in identity removal is reported
 * separately and never claimed before it is done.
 */
export default function DeleteAccountScreen() {
  const router = useRouter();
  const { signOut } = useAuth();
  const { t } = useI18n();
  const { client, refresh } = useBorrower();
  const { state, reload } = useLoad(() => client.deletionStatus(), [client]);
  const [step, setStep] = useState<1 | 2>(1);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.kind === 'loading') return <Loading label={t('common.loading')} />;
  if (state.kind === 'error')
    return (
      <ScrollScreen>
        <Heading>{t('delete.title')}</Heading>
        <ErrorState
          message={t(errorKey(state.code))}
          retryLabel={t('common.retry')}
          onRetry={reload}
        />
      </ScrollScreen>
    );

  const current = state.data.item;
  const open = current && (current.status === 'requested' || current.status === 'blocked');

  async function request() {
    setBusy(true);
    setError(null);
    const result = await client.requestDeletion();
    setBusy(false);
    if (!result.ok) return setError(t(errorKey(result.code)));
    await refresh();
    reload();
  }
  async function cancel() {
    setBusy(true);
    setError(null);
    const result = await client.cancelDeletion();
    setBusy(false);
    if (!result.ok) return setError(t(errorKey(result.code)));
    await refresh();
    reload();
  }

  return (
    <ScrollScreen>
      <Heading>{t('delete.title')}</Heading>
      <Body>{t('delete.explain')}</Body>
      {current ? (
        <Banner tone={current.status === 'blocked' ? 'warning' : 'info'}>
          {t(`delete.status.${current.status}` as MessageKey)}
        </Banner>
      ) : null}
      {current?.status === 'blocked' ? (
        <Banner tone="warning">{t('delete.blockedActive')}</Banner>
      ) : null}
      {current?.status === 'anonymised' ? (
        <>
          <Banner tone="info">{t('delete.done')}</Banner>
          {!current.signInIdentityRemoved ? <Body muted>{t('delete.signInPending')}</Body> : null}
          <Button title={t('common.signOut')} onPress={() => void signOut()} />
        </>
      ) : null}
      {open ? (
        <>
          <Body muted>{t('delete.requested')}</Body>
          <Button title={t('delete.cancel')} secondary busy={busy} onPress={() => void cancel()} />
          <Button title={t('common.retry')} secondary onPress={reload} />
        </>
      ) : null}
      {!current || current.status === 'cancelled' ? (
        step === 1 ? (
          <>
            <Body muted>{t('delete.step1')}</Body>
            <Button title={t('common.continue')} onPress={() => setStep(2)} />
          </>
        ) : (
          <>
            <Body muted>{t('delete.step2')}</Body>
            <CheckRow
              label={t('delete.confirmLabel')}
              checked={confirmed}
              onToggle={setConfirmed}
            />
            <Button
              title={t('delete.confirm')}
              busy={busy}
              disabled={!confirmed}
              onPress={() => void request()}
            />
          </>
        )
      ) : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <Button title={t('common.back')} secondary onPress={() => router.back()} />
    </ScrollScreen>
  );
}
