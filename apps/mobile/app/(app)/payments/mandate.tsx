import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { useMemo, useRef, useState } from 'react';
import { Linking } from 'react-native';
import { debitView, mandateView } from '../../../src/borrower/mandates-view';
import { payErrorKey } from '../../../src/borrower/payments-errors';
import { openHandoff } from '../../../src/borrower/payments-handoff';
import { firstParam, isUuid } from '../../../src/borrower/payments-ids';
import { mandatePollDelay } from '../../../src/borrower/payments-polling';
import { ctxFor, type Word } from '../../../src/borrower/payments-view';
import { useLoad } from '../../../src/borrower/useLoad';
import { useMandatesClient, usePolled } from '../../../src/borrower/usePayments';
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

/**
 * Mandate detail: the status in plain words, exactly as the provider-confirmed history last left it; the limits; the next planned
 * debit; the past and planned debits with their notice state; and "Request cancellation", which is a request until the provider
 * confirms. Nothing here promises that a debit will or will not happen. The provider link is a bearer secret, handled like the
 * payment link (fetched only on the tap, never kept).
 */
export default function MandateScreen() {
  const params = useLocalSearchParams<{ mandateId?: string | string[] }>();
  const router = useRouter();
  const { t } = useI18n();
  const mandateId = firstParam(params.mandateId);
  if (mandateId === undefined) return <Redirect href="/payments" />;
  if (!isUuid(mandateId)) {
    return (
      <ScrollScreen>
        <Heading>{t('mandate.detail.title')}</Heading>
        <Banner tone="danger">{t('error.invalidInput')}</Banner>
        <Button title={t('common.back')} secondary onPress={() => router.back()} />
      </ScrollScreen>
    );
  }
  return <MandateBody key={mandateId} mandateId={mandateId} />;
}

function MandateBody({ mandateId }: { mandateId: string }) {
  usePreventScreenCapture();
  const router = useRouter();
  const { t, language } = useI18n();
  const client = useMandatesClient();
  const ctx = useMemo(() => ctxFor(language), [language]);
  const say = (w: Word) => t(w.key, w.vars);
  const polled = usePolled(
    () => client.mandate(mandateId),
    (data, context) => mandatePollDelay(data, context),
  );
  const debits = useLoad(() => client.debits(mandateId), [client, mandateId]);
  const [busy, setBusy] = useState<'link' | 'cancel' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const inFlight = useRef(false);

  if (polled.state.kind === 'loading') return <Loading label={t('common.loading')} />;
  if (polled.state.kind === 'error') {
    return (
      <ScrollScreen>
        <Heading>{t('mandate.detail.title')}</Heading>
        <ErrorState
          message={t(payErrorKey(polled.state.code))}
          retryLabel={t('common.retry')}
          onRetry={polled.refresh}
        />
        <Button title={t('common.back')} secondary onPress={() => router.back()} />
      </ScrollScreen>
    );
  }

  const { data, refreshFailed } = polled.state;
  const view = mandateView(
    data,
    { linkOpened: polled.linkOpened, pollStopped: !polled.polling },
    ctx,
  );

  function refreshAll() {
    polled.refresh();
    debits.reload();
  }

  async function continueToProvider() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy('link');
    setProblem(null);
    try {
      // Fetched now, on the tap, and nowhere else. `result` is a local that dies with this function.
      const result = await client.mandateLink(mandateId);
      if (!result.ok) {
        setProblem(
          result.code === 'not_found' || result.code === 'http_404'
            ? 'mandate.link.unavailable'
            : payErrorKey(result.code),
        );
        polled.refresh();
        return;
      }
      const outcome = await openHandoff(result.data.link, (url) => Linking.openURL(url));
      if (outcome === 'opened') polled.markLinkOpened();
      else setProblem('mandate.link.failed');
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function requestCancellation() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy('cancel');
    setProblem(null);
    try {
      const result = await client.requestCancellation(mandateId);
      if (!result.ok) setProblem(payErrorKey(result.code));
      setConfirming(false);
      polled.refresh();
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  return (
    <ScrollScreen>
      <Heading>{t('mandate.detail.title')}</Heading>
      <Card>
        <Label>{say(view.headline)}</Label>
        <Body>{say(view.explain)}</Body>
      </Card>
      {view.cancelRequested ? <Banner tone="info">{say(view.cancelRequested)}</Banner> : null}
      {view.wait ? <Banner tone="info">{say(view.wait)}</Banner> : null}
      {refreshFailed ? <Banner tone="warning">{t('pay.refreshFailed')}</Banner> : null}
      {problem ? <Banner tone="danger">{t(problem)}</Banner> : null}

      {view.lines.map((line, index) => (
        <Body key={`${line.key}-${String(index)}`}>{say(line)}</Body>
      ))}
      {view.afa ? <Body muted>{say(view.afa)}</Body> : null}

      {view.openAuthorisation ? (
        <Card>
          <Body muted>{t('mandate.link.note')}</Body>
          <Button
            title={busy === 'link' ? t('mandate.link.opening') : t('mandate.link.button')}
            busy={busy === 'link'}
            disabled={busy !== null}
            onPress={() => void continueToProvider()}
          />
        </Card>
      ) : null}

      <Card>
        <Label>{say(view.next.title)}</Label>
        {view.next.line ? (
          <Body>{say(view.next.line)}</Body>
        ) : (
          <Body>{t('mandate.next.none')}</Body>
        )}
        {view.next.notice ? <Body muted>{say(view.next.notice)}</Body> : null}
        <Body muted>{say(view.next.note)}</Body>
      </Card>

      <Label>{t('mandate.debits.title')}</Label>
      {debits.state.kind === 'loading' ? <Body muted>{t('common.loading')}</Body> : null}
      {debits.state.kind === 'error' ? (
        <ErrorState
          message={t(payErrorKey(debits.state.code))}
          retryLabel={t('common.retry')}
          onRetry={debits.reload}
        />
      ) : null}
      {debits.state.kind === 'ready' && debits.state.data.items.length === 0 ? (
        <Body muted>{t('mandate.debits.empty')}</Body>
      ) : null}
      {debits.state.kind === 'ready'
        ? debits.state.data.items.map((d) => {
            const row = debitView(d, ctx);
            return (
              <Card key={row.id}>
                <Label>{row.date}</Label>
                <Body>{say(row.amount)}</Body>
                <Body>{say(row.status)}</Body>
                <Body muted>{say(row.origin)}</Body>
                {row.returned ? <Body>{say(row.returned)}</Body> : null}
                {row.notice ? <Body muted>{say(row.notice)}</Body> : null}
              </Card>
            );
          })
        : null}

      {view.canCancel ? (
        confirming ? (
          <Card>
            <Label>{t('mandate.cancel.confirmTitle')}</Label>
            <Body>{t('mandate.cancel.confirmBody')}</Body>
            <Button
              title={busy === 'cancel' ? t('mandate.cancel.busy') : t('mandate.cancel.send')}
              busy={busy === 'cancel'}
              disabled={busy !== null}
              onPress={() => void requestCancellation()}
            />
            <Button
              title={t('mandate.cancel.keep')}
              secondary
              disabled={busy !== null}
              onPress={() => setConfirming(false)}
            />
          </Card>
        ) : (
          <Button
            title={t('mandate.cancel.button')}
            secondary
            onPress={() => setConfirming(true)}
          />
        )
      ) : null}

      <Button title={t('pay.refresh')} secondary onPress={refreshAll} />
      <Button title={t('common.back')} secondary onPress={() => router.back()} />
    </ScrollScreen>
  );
}
