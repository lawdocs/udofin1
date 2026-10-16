import { useLocalSearchParams, useRouter } from 'expo-router';
import { useBorrower } from '../../src/borrower/BorrowerProvider';
import { documentStatusKey, nextStep } from '../../src/borrower/documents';
import { errorKey } from '../../src/borrower/errors';
import { formatDateTime } from '../../src/borrower/format';
import { formatRupees } from '../../src/borrower/money';
import { formatAprBps } from '../../src/borrower/routing';
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
 * The offer and everything the lender has issued for it, in one place. The offer's own validity and the Key Facts Statement's
 * validity are two separate dates and are shown as two. What the borrower can do next is derived only from what the lender and
 * the database have recorded; no countdown, no urgency.
 */
export default function DocumentsScreen() {
  const { application } = useLocalSearchParams<{ application?: string }>();
  const applicationId = application ?? '';
  const router = useRouter();
  const { t, language } = useI18n();
  const { client } = useBorrower();
  const { state, reload } = useLoad(
    () => client.applicationDocuments(applicationId),
    [client, applicationId],
  );

  if (state.kind === 'loading') return <Loading label={t('common.loading')} />;
  if (state.kind === 'error') {
    return (
      <ScrollScreen>
        <Heading>{t('docs.title')}</Heading>
        <ErrorState
          message={t(errorKey(state.code))}
          retryLabel={t('common.retry')}
          onRetry={reload}
        />
      </ScrollScreen>
    );
  }
  const docs = state.data;
  const step = nextStep(docs, new Date());
  const kfs = docs.kfs;
  const offer = docs.offer;

  return (
    <ScrollScreen>
      <Heading>{t('docs.title')}</Heading>
      <Body>{t('docs.lender', { name: docs.lenderName })}</Body>

      {offer ? (
        <Card>
          <Label>{t('docs.offerCard')}</Label>
          <Body>{t('docs.offerAmount', { amount: formatRupees(offer.principalMinor) })}</Body>
          <Body>{t('docs.offerApr', { apr: formatAprBps(offer.aprBps) })}</Body>
          <Body muted>
            {t('docs.offerValid', { date: formatDateTime(offer.validUntil, language) })}
          </Body>
        </Card>
      ) : null}

      {kfs ? (
        <Card>
          <Label>{t('docs.kfsCard')}</Label>
          <Body muted>{t('docs.version', { n: kfs.version })}</Body>
          {kfs.proposalNo ? <Body>{t('docs.kfsProposal', { no: kfs.proposalNo })}</Body> : null}
          {kfs.validUntil ? (
            <>
              <Body>{t('docs.kfsValid', { date: formatDateTime(kfs.validUntil, language) })}</Body>
              <Body muted>{t('docs.kfsValidNote')}</Body>
            </>
          ) : null}
          <Body muted>{t(documentStatusKey(kfs.issuanceStatus))}</Body>
          {docs.acknowledgement ? <Body muted>{t('docs.acknowledged')}</Body> : null}
        </Card>
      ) : null}

      <Banner tone={step === 'offer_closed' ? 'warning' : 'info'}>
        {t(`docs.next.${step}` as MessageKey)}
      </Banner>

      {step === 'review_kfs' || step === 'accept' ? (
        <Button
          title={t('docs.kfsButton')}
          onPress={() =>
            router.push({
              pathname: '/kfs',
              params: { application: applicationId, document: kfs?.documentId ?? '' },
            })
          }
        />
      ) : null}
      {step === 'review_agreement' || step === 'signing' || step === 'executed' ? (
        <Button
          title={t('docs.agreementButton')}
          onPress={() =>
            router.push({
              pathname: '/agreement',
              params: { application: applicationId, document: docs.agreement?.documentId ?? '' },
            })
          }
        />
      ) : null}

      <Label>{t('docs.all')}</Label>
      {docs.documents.length === 0 ? <Body muted>{t('docs.none')}</Body> : null}
      {docs.documents.map((d) => (
        <Card key={d.documentId}>
          <Body>
            {t(
              d.type === 'kfs'
                ? 'docs.type.kfs'
                : d.type === 'loan_agreement'
                  ? 'docs.type.loan_agreement'
                  : 'docs.type.other',
            )}{' '}
            · {t('docs.version', { n: d.version })}
          </Body>
          <Body muted>{t(documentStatusKey(d.issuanceStatus))}</Body>
          {d.issuedAt ? <Body muted>{formatDateTime(d.issuedAt, language)}</Body> : null}
          {d.acknowledged ? <Body muted>{t('docs.acknowledged')}</Body> : null}
        </Card>
      ))}
    </ScrollScreen>
  );
}
