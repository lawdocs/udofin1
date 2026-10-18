import { useRouter } from 'expo-router';
import { servicingErrorKey } from '../../../src/borrower/servicing-errors';
import { useText } from '../../../src/borrower/servicing-ui';
import { loanCardModel, unreadReminderCount } from '../../../src/borrower/servicing-view';
import { useLoad } from '../../../src/borrower/useLoad';
import { useRefreshOnFocus } from '../../../src/borrower/useRefreshOnFocus';
import { useServicing } from '../../../src/borrower/useServicing';
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
 * The borrower's loans as their lenders reported them. Every figure says whose it is and when it was reported; figures the
 * lender is checking are not shown at all. Nothing here is worked out by the app.
 */
export default function LoansScreen() {
  const router = useRouter();
  const { t, language } = useI18n();
  const tx = useText();
  const servicing = useServicing();
  const loans = useLoad(() => servicing.loans(), [servicing]);
  const reminders = useLoad(() => servicing.reminders(), [servicing]);
  useRefreshOnFocus(reminders.reload);

  if (loans.state.kind === 'loading') return <Loading label={t('common.loading')} />;
  if (loans.state.kind === 'error') {
    return (
      <ScrollScreen>
        <Heading>{t('loans.title')}</Heading>
        <ErrorState
          message={t(servicingErrorKey(loans.state.code))}
          retryLabel={t('common.retry')}
          onRetry={loans.reload}
        />
      </ScrollScreen>
    );
  }

  const cards = loans.state.data.items.map((loan) => loanCardModel(loan, language));
  const unread =
    reminders.state.kind === 'ready' ? unreadReminderCount(reminders.state.data.items) : 0;

  return (
    <ScrollScreen>
      <Heading>{t('loans.title')}</Heading>
      <Body muted>{t('loans.list.intro')}</Body>
      {cards.length === 0 ? <Banner tone="info">{t('loans.list.empty')}</Banner> : null}
      {cards.map((card) => (
        <Card key={card.loanId}>
          <Label>{card.lender}</Label>
          <Body muted>{tx(card.reference)}</Body>
          <Body>
            {tx(card.status.label)}: {tx(card.status.value)}
          </Body>
          {card.summary.map((line) => (
            <Body key={line.key} muted>
              {tx(line)}
            </Body>
          ))}
          <Button
            title={t('loans.open', { lender: card.lender })}
            onPress={() => router.push({ pathname: '/loans/[id]', params: { id: card.loanId } })}
          />
        </Card>
      ))}
      <Button
        title={unread > 0 ? t('loans.messagesUnread', { count: unread }) : t('loans.messages')}
        secondary
        onPress={() => router.push('/loans/reminders')}
      />
    </ScrollScreen>
  );
}
