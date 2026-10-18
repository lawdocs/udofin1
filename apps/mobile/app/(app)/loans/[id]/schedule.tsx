import { useLocalSearchParams } from 'expo-router';
import { LoanPage, SectionError, useText } from '../../../../src/borrower/servicing-ui';
import { type SvcLoan } from '../../../../src/borrower/servicing-types';
import { scheduleModel } from '../../../../src/borrower/servicing-view';
import { useLoad } from '../../../../src/borrower/useLoad';
import { useServicing } from '../../../../src/borrower/useServicing';
import { useI18n } from '../../../../src/i18n/I18nProvider';
import { Banner, Body, Card, Label } from '../../../../src/ui/kit';

/** The lender's instalments exactly as reported. No instalment is marked paid or due: the app allocates nothing. */
export default function ScheduleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useI18n();
  return (
    <LoanPage loanId={id ?? ''} title={t('loans.schedule.title')}>
      {(loan) => <ScheduleBody loan={loan} />}
    </LoanPage>
  );
}

function ScheduleBody({ loan }: { loan: SvcLoan }) {
  const { t, language } = useI18n();
  const tx = useText();
  const servicing = useServicing();
  const { state, reload } = useLoad(
    () => servicing.schedule(loan.loanId),
    [servicing, loan.loanId],
  );
  if (state.kind === 'loading') return <Body muted>{t('common.loading')}</Body>;
  if (state.kind === 'error') return <SectionError code={state.code} onRetry={reload} />;
  const model = scheduleModel(state.data, loan.lenderDisplayName, language);
  if (model.kind === 'none') return <Banner tone="info">{tx(model.notice)}</Banner>;
  return (
    <>
      {model.attribution ? <Body muted>{tx(model.attribution)}</Body> : null}
      <Body muted>{tx(model.note)}</Body>
      {model.rows.map((row) => (
        <Card key={row.seq}>
          <Label>{tx(row.title)}</Label>
          {row.lines.map((line) => (
            <Body key={line.key}>{tx(line)}</Body>
          ))}
        </Card>
      ))}
    </>
  );
}
