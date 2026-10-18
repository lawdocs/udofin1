import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { type MessageKey } from '../../../../src/i18n';
import { keyAfter, newActionKey } from '../../../../src/borrower/servicing';
import { servicingErrorKey } from '../../../../src/borrower/servicing-errors';
import {
  DocumentCard,
  LoanPage,
  RequestCard,
  SectionError,
} from '../../../../src/borrower/servicing-ui';
import { type SvcLoan } from '../../../../src/borrower/servicing-types';
import {
  documentKindKey,
  documentRowModel,
  parseStatementPeriod,
  requestRowModel,
} from '../../../../src/borrower/servicing-view';
import { useDocumentOpener } from '../../../../src/borrower/useDocumentOpener';
import { useLoad } from '../../../../src/borrower/useLoad';
import { useRequestActions } from '../../../../src/borrower/useRequestActions';
import { useServicing } from '../../../../src/borrower/useServicing';
import { useI18n } from '../../../../src/i18n/I18nProvider';
import { Banner, Body, Button, Card, Field, Label } from '../../../../src/ui/kit';

/**
 * Statements and the other documents the lender issued. The lender makes every document; this screen only asks for a
 * statement, lists the answers and opens a file through the API's authenticated route. A request is a request until the lender
 * answers: it can be cancelled while it is open, and nothing says "ready" before the lender provided a file.
 */
export default function StatementsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useI18n();
  return (
    <LoanPage loanId={id ?? ''} title={t('loans.stmt.title')}>
      {(loan) => <StatementsBody loan={loan} />}
    </LoanPage>
  );
}

function StatementsBody({ loan }: { loan: SvcLoan }) {
  const router = useRouter();
  const { t, language } = useI18n();
  const servicing = useServicing();
  const loanId = loan.loanId;
  const lender = loan.lenderDisplayName;
  const docs = useLoad(() => servicing.documents(loanId), [servicing, loanId]);
  const requests = useLoad(() => servicing.documentRequests(loanId), [servicing, loanId]);
  const opener = useDocumentOpener(servicing, loanId);
  const actions = useRequestActions(servicing, loanId, requests.reload);

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [formError, setFormError] = useState<MessageKey | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // One Idempotency-Key per statement request. A lost answer is retried with the same key; a change to the dates is a new request.
  const [submitKey, setSubmitKey] = useState(() => newActionKey());

  async function submit() {
    const parsed = parseStatementPeriod(from, to);
    setSent(false);
    setSendError(null);
    if (!parsed.ok) {
      setFormError(
        parsed.error === 'incomplete' ? 'loans.stmt.errIncomplete' : 'loans.stmt.errInvalid',
      );
      return;
    }
    setFormError(null);
    setSending(true);
    const result = await servicing.requestStatement(loanId, parsed.period, submitKey);
    setSending(false);
    setSubmitKey(keyAfter(result, submitKey));
    if (!result.ok) {
      setSendError(result.code);
      if (result.code === 'open_request_exists') requests.reload();
      return;
    }
    setSent(true);
    requests.reload();
  }

  const documentNotice = (documentId: string) =>
    opener.notice && opener.notice.documentId === documentId ? (
      <Banner tone="warning">{t(opener.notice.key)}</Banner>
    ) : null;

  return (
    <>
      <Body>{t('loans.stmt.intro', { lender })}</Body>

      <Card>
        <Label>{t('loans.stmt.requestTitle')}</Label>
        <Body muted>{t('loans.stmt.periodNote')}</Body>
        <Field
          label={t('loans.stmt.from')}
          value={from}
          placeholder={t('loans.stmt.dateExample')}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="numbers-and-punctuation"
          onChangeText={(text) => {
            setFrom(text);
            setSubmitKey(newActionKey());
          }}
        />
        <Field
          label={t('loans.stmt.to')}
          value={to}
          placeholder={t('loans.stmt.dateExample')}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="numbers-and-punctuation"
          onChangeText={(text) => {
            setTo(text);
            setSubmitKey(newActionKey());
          }}
          error={formError ? t(formError) : null}
        />
        {sendError ? <Banner tone="danger">{t(servicingErrorKey(sendError))}</Banner> : null}
        {sent ? <Banner tone="info">{t('loans.stmt.sent', { lender })}</Banner> : null}
        <Button
          title={sending ? t('loans.stmt.submitting') : t('loans.stmt.submit', { lender })}
          busy={sending}
          onPress={() => void submit()}
        />
      </Card>

      <Label>{t('loans.stmt.requestsTitle')}</Label>
      {actions.error ? <Banner tone="danger">{t(servicingErrorKey(actions.error))}</Banner> : null}
      {actions.cancelled ? <Banner tone="info">{t('loans.stmt.cancelled')}</Banner> : null}
      {requests.state.kind === 'loading' ? <Body muted>{t('common.loading')}</Body> : null}
      {requests.state.kind === 'error' ? (
        <SectionError code={requests.state.code} onRetry={requests.reload} />
      ) : null}
      {requests.state.kind === 'ready' && requests.state.data.items.length === 0 ? (
        <Body muted>{t('loans.stmt.requestsEmpty')}</Body>
      ) : null}
      {requests.state.kind === 'ready'
        ? requests.state.data.items.map((request) => {
            const model = requestRowModel(request, lender, language);
            return (
              <RequestCard
                key={request.requestId}
                model={model}
                busy={actions.cancelling === request.requestId}
                notice={
                  request.fulfilledDocumentId ? documentNotice(request.fulfilledDocumentId) : null
                }
                onCancel={() => void actions.cancel(request.requestId)}
                onOpenDocument={(documentId) =>
                  void opener.open(documentId, t(documentKindKey(request.kind)))
                }
                onViewQuote={() =>
                  router.push({ pathname: '/loans/[id]/quotation', params: { id: loanId } })
                }
              />
            );
          })
        : null}

      <Label>{t('loans.stmt.docsTitle', { lender })}</Label>
      {docs.state.kind === 'loading' ? <Body muted>{t('common.loading')}</Body> : null}
      {docs.state.kind === 'error' ? (
        <SectionError code={docs.state.code} onRetry={docs.reload} />
      ) : null}
      {docs.state.kind === 'ready' && docs.state.data.items.length === 0 ? (
        <Body muted>{t('loans.stmt.docsEmpty')}</Body>
      ) : null}
      {docs.state.kind === 'ready'
        ? docs.state.data.items.map((doc) => {
            const model = documentRowModel(doc, lender, language);
            return (
              <DocumentCard
                key={model.id}
                model={model}
                opening={opener.openingId === model.id}
                notice={documentNotice(model.id)}
                onOpen={() => void opener.open(model.id, t(model.viewerTitle))}
              />
            );
          })
        : null}
    </>
  );
}
