import { useLocalSearchParams, useRouter } from 'expo-router';
import { FigureLines, LoanPage, useText } from '../../../../src/borrower/servicing-ui';
import { type SvcLoan } from '../../../../src/borrower/servicing-types';
import { loanHomeModel, mandateSetupHref, payHref } from '../../../../src/borrower/servicing-view';
import { useI18n } from '../../../../src/i18n/I18nProvider';
import { Banner, Body, Button, Card, Label } from '../../../../src/ui/kit';

/**
 * One loan as the lender reported it: whose figures, as of when, and what the lender has said is next due. The two payment
 * buttons are always shown: the payment screens explain what can be paid and why something cannot.
 */
export default function LoanHomeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useI18n();
  return (
    <LoanPage loanId={id ?? ''} title={t('loans.home.title')}>
      {(loan, reload) => <LoanHomeBody loan={loan} reload={reload} />}
    </LoanPage>
  );
}

function LoanHomeBody({ loan, reload }: { loan: SvcLoan; reload: () => void }) {
  const router = useRouter();
  const { t, language } = useI18n();
  const tx = useText();
  const model = loanHomeModel(loan, language);
  const loanId = model.loanId;
  const figures = model.figures;
  return (
    <>
      <Card>
        <Label>{model.lender}</Label>
        <Body muted>{tx(model.reference)}</Body>
        <Body>
          {tx(model.status.label)}: {tx(model.status.value)}
        </Body>
        {model.reportedStatus ? (
          <Body>
            {tx(model.reportedStatus.label)}: {tx(model.reportedStatus.value)}
          </Body>
        ) : null}
        {model.statusNote ? <Body muted>{tx(model.statusNote)}</Body> : null}
        {model.facts.map((fact) => (
          <Body key={fact.key} muted>
            {tx(fact)}
          </Body>
        ))}
      </Card>

      {figures.kind === 'withheld' ? (
        <Banner tone="info">{tx(figures.notice)}</Banner>
      ) : (
        <>
          <Card>
            <Label>{tx(figures.attribution)}</Label>
            {figures.staleNotice ? <Banner tone="warning">{tx(figures.staleNotice)}</Banner> : null}
            <FigureLines rows={figures.rows} lender={model.lender} />
          </Card>
          {figures.overdue ? (
            <Card>
              <Label>{tx(figures.overdue.title)}</Label>
              <FigureLines rows={figures.overdue.rows} lender={model.lender} />
              <Body muted>{tx(figures.overdue.note)}</Body>
            </Card>
          ) : null}
        </>
      )}

      <Button title={t('loans.home.refresh')} secondary onPress={reload} />
      <Button title={t('loans.home.pay')} onPress={() => router.push(payHref(loanId))} />
      <Button
        title={t('loans.home.autopay')}
        secondary
        onPress={() => router.push(mandateSetupHref(loanId))}
      />
      <Button
        title={t('loans.home.schedule')}
        secondary
        onPress={() => router.push({ pathname: '/loans/[id]/schedule', params: { id: loanId } })}
      />
      <Button
        title={t('loans.home.activity')}
        secondary
        onPress={() => router.push({ pathname: '/loans/[id]/activity', params: { id: loanId } })}
      />
      <Button
        title={t('loans.home.statements')}
        secondary
        onPress={() => router.push({ pathname: '/loans/[id]/statements', params: { id: loanId } })}
      />
      <Button
        title={t('loans.home.quote')}
        secondary
        onPress={() => router.push({ pathname: '/loans/[id]/quotation', params: { id: loanId } })}
      />
      <Button
        title={t('loans.home.closure')}
        secondary
        onPress={() => router.push({ pathname: '/loans/[id]/closure', params: { id: loanId } })}
      />
    </>
  );
}
