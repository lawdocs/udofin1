import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { keyAfter, newActionKey } from '../../../../src/borrower/servicing';
import { servicingErrorKey } from '../../../../src/borrower/servicing-errors';
import {
  FigureLines,
  LoanPage,
  RequestCard,
  SectionError,
  useText,
} from '../../../../src/borrower/servicing-ui';
import { type SvcLoan } from '../../../../src/borrower/servicing-types';
import {
  openRequestOfKind,
  payQuotationHref,
  quoteModel,
  requestRowModel,
} from '../../../../src/borrower/servicing-view';
import { useDocumentOpener } from '../../../../src/borrower/useDocumentOpener';
import { useLoad } from '../../../../src/borrower/useLoad';
import { useRequestActions } from '../../../../src/borrower/useRequestActions';
import { useServicing } from '../../../../src/borrower/useServicing';
import { useI18n } from '../../../../src/i18n/I18nProvider';
import { Banner, Body, Button, Card, Label } from '../../../../src/ui/kit';

/**
 * The lender's foreclosure quotation, exactly as the lender stated it, with the date and time until which the lender says it is
 * valid (a date, not a timer). A quotation whose parts do not add up to its total is shown as flagged, with no way to pay it:
 * the only action is to ask the lender for a corrected one.
 */
export default function QuotationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useI18n();
  return (
    <LoanPage loanId={id ?? ''} title={t('loans.quote.title')}>
      {(loan) => <QuotationBody loan={loan} />}
    </LoanPage>
  );
}

function QuotationBody({ loan }: { loan: SvcLoan }) {
  const router = useRouter();
  const { t, language } = useI18n();
  const tx = useText();
  const servicing = useServicing();
  const loanId = loan.loanId;
  const lender = loan.lenderDisplayName;
  const latest = useLoad(() => servicing.latestQuote(loanId), [servicing, loanId]);
  const requests = useLoad(() => servicing.documentRequests(loanId), [servicing, loanId]);
  const opener = useDocumentOpener(servicing, loanId);
  const actions = useRequestActions(servicing, loanId, requests.reload);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [requestKey, setRequestKey] = useState(() => newActionKey());

  async function requestQuote() {
    setSending(true);
    setSent(false);
    setSendError(null);
    const result = await servicing.requestForeclosureQuote(loanId, requestKey);
    setSending(false);
    setRequestKey(keyAfter(result, requestKey));
    if (!result.ok) {
      setSendError(result.code);
      if (result.code === 'open_request_exists') requests.reload();
      return;
    }
    setSent(true);
    requests.reload();
  }

  const open =
    requests.state.kind === 'ready'
      ? openRequestOfKind(requests.state.data.items, 'foreclosure_quote')
      : null;

  return (
    <>
      <Body>{t('loans.quote.intro', { lender })}</Body>

      {latest.state.kind === 'loading' ? <Body muted>{t('common.loading')}</Body> : null}
      {latest.state.kind === 'error' ? (
        <SectionError code={latest.state.code} onRetry={latest.reload} />
      ) : null}

      {latest.state.kind === 'ready' && latest.state.data.quote === null ? (
        <Banner tone="info">{t('loans.quote.none', { lender })}</Banner>
      ) : null}

      {latest.state.kind === 'ready' && latest.state.data.quote !== null
        ? (() => {
            const quote = quoteModel(latest.state.data.quote, lender, language);
            return (
              <Card>
                <Label>{tx(quote.attribution)}</Label>
                <Body muted>{tx(quote.asOf)}</Body>
                <Body>{tx(quote.validUntil)}</Body>
                {quote.notices.map((n) => (
                  <Banner key={n.key} tone="warning">
                    {tx(n)}
                  </Banner>
                ))}
                {quote.mismatch ? <Banner tone="warning">{tx(quote.mismatch)}</Banner> : null}
                <FigureLines rows={quote.parts} lender={lender} />
                <FigureLines rows={[quote.total]} lender={lender} />
                {opener.notice && opener.notice.documentId === quote.letterDocumentId ? (
                  <Banner tone="warning">{t(opener.notice.key)}</Banner>
                ) : null}
                {quote.letterDocumentId ? (
                  <Button
                    title={
                      opener.openingId === quote.letterDocumentId
                        ? t('loans.doc.opening')
                        : t('loans.quote.letter')
                    }
                    secondary
                    busy={opener.openingId === quote.letterDocumentId}
                    onPress={() =>
                      void opener.open(
                        quote.letterDocumentId ?? '',
                        t('loans.doc.kind.foreclosure_quote'),
                      )
                    }
                  />
                ) : null}
                {quote.canPay ? (
                  <Button
                    title={t('loans.quote.pay')}
                    onPress={() => router.push(payQuotationHref(loanId))}
                  />
                ) : null}
              </Card>
            );
          })()
        : null}

      {sendError ? <Banner tone="danger">{t(servicingErrorKey(sendError))}</Banner> : null}
      {sent ? <Banner tone="info">{t('loans.quote.sent', { lender })}</Banner> : null}
      {actions.error ? <Banner tone="danger">{t(servicingErrorKey(actions.error))}</Banner> : null}
      {actions.cancelled ? <Banner tone="info">{t('loans.stmt.cancelled')}</Banner> : null}

      {open ? (
        <RequestCard
          model={requestRowModel(open, lender, language)}
          busy={actions.cancelling === open.requestId}
          onCancel={() => void actions.cancel(open.requestId)}
        />
      ) : null}

      {latest.state.kind === 'ready' &&
      (latest.state.data.quote === null || latest.state.data.quote.totalMismatch) &&
      open === null ? (
        <Button
          title={
            sending
              ? t('loans.quote.requesting')
              : latest.state.data.quote === null
                ? t('loans.quote.request', { lender })
                : t('loans.quote.requestCorrected', { lender })
          }
          busy={sending}
          onPress={() => void requestQuote()}
        />
      ) : null}
    </>
  );
}
