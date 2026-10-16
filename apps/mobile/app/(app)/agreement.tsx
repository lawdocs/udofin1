import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { useBorrower } from '../../src/borrower/BorrowerProvider';
import { signingKey } from '../../src/borrower/documents';
import { errorKey } from '../../src/borrower/errors';
import { newIdempotencyKey } from '../../src/borrower/form';
import { openPdf, type OpenResult } from '../../src/borrower/pdf-open';
import { useLoad } from '../../src/borrower/useLoad';
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

/**
 * The loan agreement (with the KFS as its summary box), the signing status exactly as the provider reported it, and a
 * content-free notice request. A one-time code only starts signing; it is never described as the signature. Delivery says what
 * the provider said: "accepted" is not "arrived".
 */
export default function AgreementScreen() {
  const params = useLocalSearchParams<{ application?: string; document?: string }>();
  const applicationId = params.application ?? '';
  const documentId = params.document ?? '';
  const router = useRouter();
  const { t } = useI18n();
  const { client } = useBorrower();
  const docs = useLoad(() => client.applicationDocuments(applicationId), [client, applicationId]);
  const [opening, setOpening] = useState(false);
  const [openResult, setOpenResult] = useState<OpenResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<string | null>(null);
  const [signKey, setSignKey] = useState(() => newIdempotencyKey());

  if (docs.state.kind === 'loading') return <Loading label={t('common.loading')} />;
  if (docs.state.kind === 'error') {
    return (
      <ScrollScreen>
        <Heading>{t('agr.title')}</Heading>
        <ErrorState
          message={t(errorKey(docs.state.code))}
          retryLabel={t('common.retry')}
          onRetry={docs.reload}
        />
      </ScrollScreen>
    );
  }
  const d = docs.state.data;
  const signing = d.signing;

  async function openFile() {
    setOpening(true);
    setError(null);
    const result = await client.documentContent(documentId, 'view');
    if (!result.ok) {
      setOpening(false);
      return setError(result.code);
    }
    setOpenResult(await openPdf(result.data.contentBase64, t('agr.title')));
    setOpening(false);
  }

  async function start() {
    setBusy(true);
    setError(null);
    const result = await client.startSigning(documentId, signKey);
    setBusy(false);
    if (!result.ok) {
      if (result.code !== 'network_error') setSignKey(newIdempotencyKey());
      return setError(result.code);
    }
    docs.reload();
  }

  async function notify() {
    setError(null);
    const result = await client.requestDelivery(documentId, 'sms_notice');
    if (!result.ok) return setError(result.code);
    setDelivery(result.data.status);
  }

  return (
    <ScrollScreen>
      <Heading>{t('agr.title')}</Heading>
      <Body>{t('agr.intro')}</Body>
      <Button
        title={opening ? t('kfs.opening') : t('agr.open')}
        busy={opening}
        onPress={() => void openFile()}
      />
      {openResult === 'opened' ? <Banner tone="info">{t('kfs.opened')}</Banner> : null}
      {openResult === 'no_viewer' ? <Banner tone="warning">{t('kfs.noViewer')}</Banner> : null}
      {openResult === 'failed' ? <Banner tone="danger">{t('kfs.openFailed')}</Banner> : null}

      <Card>
        <Label>{t('agr.signingTitle')}</Label>
        <Body muted>{t('agr.signNote')}</Body>
        {signing ? (
          <>
            <Banner
              tone={
                signing.state === 'failed' || signing.state === 'requires_reconciliation'
                  ? 'warning'
                  : 'info'
              }
            >
              {t(signingKey(signing.state))}
            </Banner>
            {signing.providerMode === 'mock' ? (
              <Banner tone="warning">{t('agr.testMode')}</Banner>
            ) : null}
            <Button title={t('agr.refresh')} secondary onPress={docs.reload} />
          </>
        ) : (
          <>
            {error === 'signing_not_available' || error === 'mock_signing_blocked' ? (
              <Banner tone="warning">{t('agr.notAvailable')}</Banner>
            ) : null}
            <Button
              title={t('agr.verify')}
              secondary
              onPress={() =>
                router.push({
                  pathname: '/stepup',
                  params: { action: 'esign', contextRef: documentId },
                })
              }
            />
            <Button title={t('agr.start')} busy={busy} onPress={() => void start()} />
          </>
        )}
      </Card>

      <Card>
        <Label>{t('agr.deliveryTitle')}</Label>
        <Button title={t('agr.deliveryButton')} secondary onPress={() => void notify()} />
        {delivery ? <Body muted>{t(`agr.delivery.${delivery}` as MessageKey)}</Body> : null}
      </Card>

      {error && error !== 'signing_not_available' && error !== 'mock_signing_blocked' ? (
        <Banner tone="danger">{t(errorKey(error))}</Banner>
      ) : null}
      <Button
        title={t('docs.title')}
        secondary
        onPress={() =>
          router.replace({ pathname: '/documents', params: { application: applicationId } })
        }
      />
    </ScrollScreen>
  );
}
