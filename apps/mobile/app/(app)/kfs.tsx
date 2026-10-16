import Constants from 'expo-constants';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { useBorrower } from '../../src/borrower/BorrowerProvider';
import {
  ackBlock,
  KFS_SECTIONS,
  kfsRows,
  shownSections,
  type KfsSectionKey,
} from '../../src/borrower/documents';
import { errorKey } from '../../src/borrower/errors';
import { formatDateTime } from '../../src/borrower/format';
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
  CheckRow,
  ErrorState,
  Heading,
  Label,
  Loading,
  ScrollScreen,
} from '../../src/ui/kit';

const APP_VERSION =
  String(Constants.expoConfig?.version ?? '0.0.0')
    .replace(/[^0-9A-Za-z.+-]/g, '')
    .slice(0, 40) || '0.0.0';

/**
 * Review, acknowledge and accept. The lender's figures are shown exactly as stated, with a plain explanation of each section
 * that changes no term. Acknowledging needs an explicit tap on approved wording after the borrower opened the file and every
 * section; a download or a screen change is never an acknowledgement. Accepting needs a one-time code for this very offer and is
 * not a signature and not a payout.
 */
export default function KfsScreen() {
  const params = useLocalSearchParams<{ application?: string; document?: string }>();
  const applicationId = params.application ?? '';
  const documentId = params.document ?? '';
  const router = useRouter();
  const { t, language } = useI18n();
  const { client } = useBorrower();
  const view = useLoad(() => client.kfsView(documentId, language), [client, documentId, language]);
  const docs = useLoad(() => client.applicationDocuments(applicationId), [client, applicationId]);
  // `shown`: sections the borrower opened (counts for the acknowledgement, never removed). `expanded`: what is open now.
  const [shown, setShown] = useState<ReadonlySet<KfsSectionKey>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<KfsSectionKey>>(new Set());
  const [fileOpened, setFileOpened] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openResult, setOpenResult] = useState<OpenResult | 'error' | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState<'ack' | 'accept' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acceptedNow, setAcceptedNow] = useState(false);
  const [ackKey, setAckKey] = useState(() => newIdempotencyKey());
  const [acceptKey, setAcceptKey] = useState(() => newIdempotencyKey());

  if (view.state.kind === 'loading' || docs.state.kind === 'loading')
    return <Loading label={t('common.loading')} />;
  if (view.state.kind === 'error' || docs.state.kind === 'error') {
    const code =
      view.state.kind === 'error'
        ? view.state.code
        : docs.state.kind === 'error'
          ? docs.state.code
          : 'generic';
    return (
      <ScrollScreen>
        <Heading>{t('kfs.title')}</Heading>
        <ErrorState
          message={t(errorKey(code))}
          retryLabel={t('common.retry')}
          onRetry={() => {
            view.reload();
            docs.reload();
          }}
        />
      </ScrollScreen>
    );
  }
  const kfs = view.state.data;
  const d = docs.state.data;
  const offerId = d.offer?.offerId ?? '';
  const acknowledged = kfs.acknowledged || d.acknowledgement !== null;
  const accepted = acceptedNow || d.acceptance !== null;
  const rows = kfs.data ? kfsRows(kfs.data, t) : null;
  const block = ackBlock({ shown, fileOpened, checked, view: { ...kfs, acknowledged } });

  async function openFile() {
    setOpening(true);
    setOpenResult(null);
    setError(null);
    const result = await client.documentContent(kfs.documentId, 'view');
    if (!result.ok) {
      setOpening(false);
      return setError(result.code);
    }
    const outcome = await openPdf(result.data.contentBase64, t('kfs.title'));
    setOpenResult(outcome);
    // The file was fetched and handed over; if no viewer exists the figures below are still all readable.
    setFileOpened(outcome === 'opened' || (outcome === 'no_viewer' && kfs.data !== null));
    setOpening(false);
  }

  async function acknowledge() {
    if (!kfs.wording || block !== null) return;
    setBusy('ack');
    setError(null);
    const result = await client.acknowledgeKfs(
      kfs.documentId,
      {
        noticeId: kfs.wording.noticeId,
        sections: shownSections(shown, kfs.sourceMode),
        action: 'checkbox_and_button',
        explanationVersion: 'v1',
        appVersion: APP_VERSION,
      },
      ackKey,
    );
    setBusy(null);
    if (!result.ok) {
      setAckKey(newIdempotencyKey());
      return setError(result.code);
    }
    docs.reload();
    view.reload();
  }

  async function accept() {
    if (!d.acknowledgement) return;
    setBusy('accept');
    setError(null);
    const result = await client.acceptOffer(
      offerId,
      { kfsDocumentId: kfs.documentId, acknowledgementId: d.acknowledgement.acknowledgementId },
      acceptKey,
    );
    setBusy(null);
    if (!result.ok) {
      // A refused attempt may be tried again as a new decision; a lost answer (offline) is retried with the same key.
      if (result.code !== 'network_error') setAcceptKey(newIdempotencyKey());
      return setError(result.code);
    }
    setAcceptedNow(true);
    docs.reload();
  }

  return (
    <ScrollScreen>
      <Heading>{t('kfs.title')}</Heading>
      <Body>{t('kfs.intro')}</Body>
      <Body muted>{t('kfs.lender', { name: kfs.lenderName })}</Body>
      {kfs.proposalNo ? <Body muted>{t('docs.kfsProposal', { no: kfs.proposalNo })}</Body> : null}
      {kfs.validFrom && kfs.validUntil ? (
        <Body muted>
          {t('kfs.validity', {
            from: formatDateTime(kfs.validFrom, language),
            until: formatDateTime(kfs.validUntil, language),
          })}
        </Body>
      ) : null}
      <Body muted>{t('kfs.validityNote')}</Body>

      <Button
        title={opening ? t('kfs.opening') : t('kfs.openFile')}
        busy={opening}
        onPress={() => void openFile()}
      />
      {fileOpened ? <Banner tone="info">{t('kfs.opened')}</Banner> : null}
      {openResult === 'no_viewer' ? <Banner tone="warning">{t('kfs.noViewer')}</Banner> : null}
      {openResult === 'failed' ? <Banner tone="danger">{t('kfs.openFailed')}</Banner> : null}
      {kfs.data === null ? <Banner tone="info">{t('kfs.uploadedNote')}</Banner> : null}

      {rows
        ? KFS_SECTIONS.map((section) => {
            const open = expanded.has(section);
            return (
              <Card key={section}>
                <Label>{t(`kfs.section.${section}` as MessageKey)}</Label>
                <Button
                  title={open ? t('kfs.hide') : t('kfs.show')}
                  secondary
                  onPress={() => {
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(section)) next.delete(section);
                      else next.add(section);
                      return next;
                    });
                    setShown((prev) => new Set(prev).add(section));
                  }}
                />
                {open ? (
                  <>
                    <Body muted>{t('kfs.explainNote')}</Body>
                    <Body muted>{t(`kfs.explain.${section}` as MessageKey)}</Body>
                    {rows[section].map((r, i) => (
                      <Body key={`${r.labelKey}-${String(i)}`}>
                        {t(r.labelKey)}: {r.value}
                      </Body>
                    ))}
                  </>
                ) : null}
              </Card>
            );
          })
        : null}

      {error ? <Banner tone="danger">{t(errorKey(error))}</Banner> : null}

      <Card>
        <Label>{t('kfs.wording.title')}</Label>
        {kfs.wording ? (
          <>
            {kfs.wording.languageFallback ? (
              <Banner tone="warning">{t('kfs.wording.fallback')}</Banner>
            ) : null}
            <Body>{kfs.wording.body}</Body>
            <Body muted>{t('consent.version', { version: kfs.wording.version })}</Body>
          </>
        ) : (
          <Banner tone="warning">{t('kfs.wording.none')}</Banner>
        )}
        {acknowledged ? (
          <Banner tone="info">{t('kfs.acked')}</Banner>
        ) : (
          <>
            <CheckRow
              label={t('kfs.confirmCheck')}
              checked={checked}
              onToggle={setChecked}
              disabled={!kfs.wording}
            />
            {block ? <Body muted>{t(`kfs.block.${block}` as MessageKey)}</Body> : null}
            <Button
              title={busy === 'ack' ? t('kfs.acking') : t('kfs.ack')}
              busy={busy === 'ack'}
              disabled={block !== null}
              onPress={() => void acknowledge()}
            />
          </>
        )}
      </Card>

      {acknowledged ? (
        <Card>
          <Label>{t('kfs.accept.title')}</Label>
          <Body muted>{t('kfs.accept.note')}</Body>
          {accepted ? (
            <>
              <Banner tone="info">{t('kfs.accept.done')}</Banner>
              <Button
                title={t('docs.title')}
                onPress={() =>
                  router.replace({ pathname: '/documents', params: { application: applicationId } })
                }
              />
            </>
          ) : (
            <>
              {error === 'stepup_required' ? (
                <Banner tone="warning">{t('kfs.accept.codeNeeded')}</Banner>
              ) : null}
              <Button
                title={t('kfs.accept.verify')}
                secondary
                onPress={() =>
                  router.push({
                    pathname: '/stepup',
                    params: { action: 'offer_acceptance', contextRef: offerId },
                  })
                }
              />
              <Button
                title={busy === 'accept' ? t('kfs.accept.busy') : t('kfs.accept.button')}
                busy={busy === 'accept'}
                onPress={() => void accept()}
              />
            </>
          )}
        </Card>
      ) : null}
    </ScrollScreen>
  );
}
