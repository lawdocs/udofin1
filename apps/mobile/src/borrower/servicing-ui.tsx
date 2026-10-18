import { useRouter } from 'expo-router';
import { useCallback, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider';
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
} from '../ui/kit';
import { servicingErrorKey } from './servicing-errors';
import { type SvcLoan } from './servicing-types';
import {
  type DocumentRowModel,
  type FigureRow,
  type RequestRowModel,
  type TextRef,
} from './servicing-view';
import { useLoad } from './useLoad';
import { useServicing } from './useServicing';

/** Turns a message description from the view models into the borrower's language. */
export function useText(): (text: TextRef) => string {
  const { t } = useI18n();
  return useCallback((text: TextRef) => t(text.key, text.vars), [t]);
}

/** "Label: value" lines. A value the lender did not report is written as such, never as zero. */
export function FigureLines({ rows, lender }: { rows: readonly FigureRow[]; lender: string }) {
  const { t } = useI18n();
  const tx = useText();
  return (
    <>
      {rows.map((row) => (
        <Body key={row.label.key}>
          {tx(row.label)}: {row.value ?? t('loans.fig.notReported', { lender })}
        </Body>
      ))}
    </>
  );
}

/** Heading, lender name and a way back, around one loan's page. The loan is loaded here; the body is a component of its own. */
export function LoanPage({
  loanId,
  title,
  children,
}: {
  loanId: string;
  title: string;
  children: (loan: SvcLoan, reloadLoan: () => void) => ReactNode;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const servicing = useServicing();
  const { state, reload } = useLoad(() => servicing.loan(loanId), [servicing, loanId]);
  const back = (
    <Button
      title={t('common.back')}
      secondary
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/loans'))}
    />
  );
  if (state.kind === 'loading') return <Loading label={t('common.loading')} />;
  if (state.kind === 'error') {
    return (
      <ScrollScreen>
        <Heading>{title}</Heading>
        <ErrorState
          message={t(servicingErrorKey(state.code))}
          retryLabel={t('common.retry')}
          onRetry={reload}
        />
        {back}
      </ScrollScreen>
    );
  }
  return (
    <ScrollScreen>
      <Heading>{title}</Heading>
      <Body muted>{state.data.lenderDisplayName}</Body>
      {children(state.data, reload)}
      {back}
    </ScrollScreen>
  );
}

/** A section's own failure: says what happened and offers retry, without taking the rest of the page down. */
export function SectionError({ code, onRetry }: { code: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <ErrorState
      message={t(servicingErrorKey(code))}
      retryLabel={t('common.retry')}
      onRetry={onRetry}
    />
  );
}

/** One statement or quotation request: its status in the API's words, the lender's own note, and what can be done with it. */
export function RequestCard({
  model,
  busy,
  notice,
  onCancel,
  onOpenDocument,
  onViewQuote,
}: {
  model: RequestRowModel;
  busy: boolean;
  /** A message about opening the document this request was answered with. */
  notice?: ReactNode;
  onCancel: () => void;
  onOpenDocument?: (documentId: string) => void;
  onViewQuote?: () => void;
}) {
  const { t } = useI18n();
  const tx = useText();
  return (
    <Card>
      <Label>{tx(model.title)}</Label>
      <Body>{tx(model.status)}</Body>
      <Body muted>{tx(model.requested)}</Body>
      {model.period ? <Body muted>{tx(model.period)}</Body> : null}
      {model.due ? <Body muted>{tx(model.due)}</Body> : null}
      {model.dueNote ? <Body muted>{tx(model.dueNote)}</Body> : null}
      {model.lenderNote ? (
        <>
          <Label>{tx(model.lenderNote.label)}</Label>
          <Body>{model.lenderNote.text}</Body>
        </>
      ) : null}
      {notice}
      {model.fulfilledDocumentId && onOpenDocument ? (
        <Button
          title={t('loans.stmt.openDocument')}
          secondary
          onPress={() => onOpenDocument(model.fulfilledDocumentId ?? '')}
        />
      ) : null}
      {model.fulfilledQuoteId && onViewQuote ? (
        <Button title={t('loans.stmt.viewQuote')} secondary onPress={onViewQuote} />
      ) : null}
      {model.canCancel ? (
        <Button
          title={busy ? t('loans.stmt.cancelling') : t('loans.stmt.cancel')}
          secondary
          busy={busy}
          onPress={onCancel}
        />
      ) : null}
    </Card>
  );
}

/** One lender-issued file in the list, with the button that opens it through the API. */
export function DocumentCard({
  model,
  opening,
  notice,
  onOpen,
}: {
  model: DocumentRowModel;
  opening: boolean;
  notice: ReactNode;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const tx = useText();
  return (
    <Card>
      <Label>{tx(model.title)}</Label>
      <Body muted>{tx(model.reference)}</Body>
      <Body muted>{tx(model.issued)}</Body>
      {model.period ? <Body muted>{tx(model.period)}</Body> : null}
      {model.notices.map((n) => (
        <Banner key={n.key} tone="warning">
          {tx(n)}
        </Banner>
      ))}
      {notice}
      <Button
        title={opening ? t('loans.doc.opening') : t('loans.doc.open')}
        secondary
        busy={opening}
        onPress={onOpen}
      />
    </Card>
  );
}
