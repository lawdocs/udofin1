import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { Linking } from 'react-native';
import { openHandoff } from '../../../src/borrower/payments-handoff';
import { payErrorKey } from '../../../src/borrower/payments-errors';
import { firstParam, isUuid } from '../../../src/borrower/payments-ids';
import { paymentPollDelay } from '../../../src/borrower/payments-polling';
import { ctxFor, paymentStatusView, type Word } from '../../../src/borrower/payments-view';
import { usePaymentsClient, usePolled } from '../../../src/borrower/usePayments';
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
 * Payment status: where the payment stands, in the API's honest stage words. Coming back from the provider's page never shows
 * "paid": the payment is read again and the stage is whatever the API says. The provider link is a bearer secret; it is fetched
 * only when the borrower taps, used inside that one handler and never kept (no state, no navigation parameter, no log, no copy).
 */
export default function PaymentStatusScreen() {
  const params = useLocalSearchParams<{ paymentId?: string | string[] }>();
  const router = useRouter();
  const { t } = useI18n();
  const paymentId = firstParam(params.paymentId);
  if (!isUuid(paymentId)) {
    return (
      <ScrollScreen>
        <Heading>{t('pay.status.title')}</Heading>
        <Banner tone="danger">{t('error.invalidInput')}</Banner>
        <Button title={t('common.back')} secondary onPress={() => router.back()} />
      </ScrollScreen>
    );
  }
  return <StatusBody key={paymentId} paymentId={paymentId} />;
}

function StatusBody({ paymentId }: { paymentId: string }) {
  const router = useRouter();
  const { t, language } = useI18n();
  const client = usePaymentsClient();
  const ctx = useMemo(() => ctxFor(language), [language]);
  const say = (w: Word) => t(w.key, w.vars);
  const polled = usePolled(
    () => client.payment(paymentId),
    (data, context) => paymentPollDelay(data, context),
  );
  const [busy, setBusy] = useState<'link' | 'cancel' | null>(null);
  // Only a message KEY is kept for a failure, never the link and never the system's message.
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const inFlight = useRef(false);

  if (polled.state.kind === 'loading') return <Loading label={t('common.loading')} />;
  if (polled.state.kind === 'error') {
    return (
      <ScrollScreen>
        <Heading>{t('pay.status.title')}</Heading>
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
  const view = paymentStatusView(
    data,
    { linkOpened: polled.linkOpened, pollStopped: !polled.polling },
    ctx,
  );

  async function continueToProvider() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy('link');
    setProblem(null);
    try {
      // Fetched now, on the tap, and nowhere else. `result` is a local that dies with this function.
      const result = await client.paymentLink(paymentId);
      if (!result.ok) {
        setProblem(
          result.code === 'not_found' || result.code === 'http_404'
            ? 'pay.link.unavailable'
            : payErrorKey(result.code),
        );
        polled.refresh();
        return;
      }
      const outcome = await openHandoff(result.data.link, (url) => Linking.openURL(url));
      if (outcome === 'opened') polled.markLinkOpened();
      else setProblem('pay.link.failed');
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function cancel() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy('cancel');
    setProblem(null);
    try {
      const result = await client.cancelPayment(paymentId);
      if (!result.ok) setProblem(payErrorKey(result.code));
      polled.refresh();
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  return (
    <ScrollScreen>
      <Heading>{t('pay.status.title')}</Heading>
      <Card>
        <Label>{say(view.headline)}</Label>
        {view.explain ? <Body>{say(view.explain)}</Body> : null}
      </Card>
      {view.lines.map((line, index) => (
        <Body key={`${line.key}-${String(index)}`}>{say(line)}</Body>
      ))}

      {view.wait ? <Banner tone="info">{say(view.wait)}</Banner> : null}
      {refreshFailed ? <Banner tone="warning">{t('pay.refreshFailed')}</Banner> : null}
      {problem ? <Banner tone="danger">{t(problem)}</Banner> : null}

      {view.link ? (
        <Card>
          <Body muted>{t('pay.link.note')}</Body>
          {view.link.until ? <Body muted>{say(view.link.until)}</Body> : null}
          <Button
            title={busy === 'link' ? t('pay.link.opening') : t('pay.link.button')}
            busy={busy === 'link'}
            disabled={busy !== null}
            onPress={() => void continueToProvider()}
          />
        </Card>
      ) : null}
      {view.linkMissing ? <Body muted>{say(view.linkMissing)}</Body> : null}

      {view.cancellable ? (
        <Card>
          <Body muted>{t('pay.cancel.note')}</Body>
          <Button
            title={busy === 'cancel' ? t('pay.cancel.busy') : t('pay.cancel.button')}
            secondary
            busy={busy === 'cancel'}
            disabled={busy !== null}
            onPress={() => void cancel()}
          />
        </Card>
      ) : null}

      <Button title={t('pay.refresh')} secondary onPress={polled.refresh} />
      {view.ended ? (
        <Button
          title={t('pay.again')}
          secondary
          onPress={() =>
            router.replace({ pathname: '/payments/pay', params: { loanId: data.loanId } })
          }
        />
      ) : null}
      <Button title={t('common.back')} secondary onPress={() => router.back()} />
    </ScrollScreen>
  );
}
