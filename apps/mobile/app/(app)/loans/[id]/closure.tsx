import { useLocalSearchParams } from 'expo-router';
import { LoanPage, SectionError, useText } from '../../../../src/borrower/servicing-ui';
import { type SvcLoan } from '../../../../src/borrower/servicing-types';
import { closureModel, type ClosureItem } from '../../../../src/borrower/servicing-view';
import { useDocumentOpener } from '../../../../src/borrower/useDocumentOpener';
import { useLoad } from '../../../../src/borrower/useLoad';
import { useServicing } from '../../../../src/borrower/useServicing';
import { useI18n } from '../../../../src/i18n/I18nProvider';
import { Banner, Body, Button, Card, Label } from '../../../../src/ui/kit';

/**
 * What the lender has reported about closing the loan: the no-dues letter and the release of any security. Every status is the
 * lender's. Wording comes from the prompt keys the API returns, mapped to this app's own text; an unknown key shows a neutral
 * line. Nothing here says that Udofin or this app released, issued or verified anything.
 */
export default function ClosureScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useI18n();
  return (
    <LoanPage loanId={id ?? ''} title={t('loans.closure.title')}>
      {(loan) => <ClosureBody loan={loan} />}
    </LoanPage>
  );
}

function ClosureBody({ loan }: { loan: SvcLoan }) {
  const { t, language } = useI18n();
  const tx = useText();
  const servicing = useServicing();
  const loanId = loan.loanId;
  const { state, reload } = useLoad(() => servicing.closure(loanId), [servicing, loanId]);
  const opener = useDocumentOpener(servicing, loanId);

  if (state.kind === 'loading') return <Body muted>{t('common.loading')}</Body>;
  if (state.kind === 'error') return <SectionError code={state.code} onRetry={reload} />;
  const model = closureModel(state.data.closure, loan.lenderDisplayName, language);
  if (model.kind === 'none') return <Banner tone="info">{tx(model.notice)}</Banner>;

  const item = (entry: ClosureItem) => (
    <Card key={entry.id}>
      <Label>{tx(entry.heading)}</Label>
      <Body>{tx(entry.line)}</Body>
      {entry.confirmedOn ? <Body muted>{tx(entry.confirmedOn)}</Body> : null}
      {entry.due ? <Body muted>{tx(entry.due)}</Body> : null}
      {entry.dueNote ? <Body muted>{tx(entry.dueNote)}</Body> : null}
      {entry.delay ? (
        <>
          <Label>{tx(entry.delay.label)}</Label>
          <Body>{entry.delay.text}</Body>
        </>
      ) : null}
      {entry.documentId && opener.notice && opener.notice.documentId === entry.documentId ? (
        <Banner tone="warning">{t(opener.notice.key)}</Banner>
      ) : null}
      {entry.documentId ? (
        <Button
          title={
            opener.openingId === entry.documentId
              ? t('loans.doc.opening')
              : t('loans.closure.noc.open')
          }
          secondary
          busy={opener.openingId === entry.documentId}
          onPress={() => void opener.open(entry.documentId ?? '', t('loans.doc.kind.noc'))}
        />
      ) : null}
    </Card>
  );

  return (
    <>
      <Banner tone="info">{tx(model.headline)}</Banner>
      <Body muted>{tx(model.recorded)}</Body>
      {item(model.noc)}
      {model.security.map(item)}
      <Body muted>{tx(model.footer)}</Body>
    </>
  );
}
