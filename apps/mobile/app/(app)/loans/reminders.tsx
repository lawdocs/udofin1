import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { newActionKey } from '../../../src/borrower/servicing';
import { servicingErrorKey } from '../../../src/borrower/servicing-errors';
import { useText } from '../../../src/borrower/servicing-ui';
import { reminderModel, shouldMarkRead } from '../../../src/borrower/servicing-view';
import { useLoad } from '../../../src/borrower/useLoad';
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
 * Messages the lenders asked us to show. The wording is the lender's approved text, exactly as returned: never shortened,
 * translated or rewritten here. A message is marked read when the borrower opens it, and shown as read only after the API said so.
 */
export default function RemindersScreen() {
  const router = useRouter();
  const { t, language } = useI18n();
  const tx = useText();
  const servicing = useServicing();
  const { state, reload } = useLoad(() => servicing.reminders(), [servicing]);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [readNow, setReadNow] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());

  if (state.kind === 'loading') return <Loading label={t('common.loading')} />;
  if (state.kind === 'error') {
    return (
      <ScrollScreen>
        <Heading>{t('reminders.title')}</Heading>
        <ErrorState
          message={t(servicingErrorKey(state.code))}
          retryLabel={t('common.retry')}
          onRetry={reload}
        />
        <Button title={t('common.back')} secondary onPress={() => router.back()} />
      </ScrollScreen>
    );
  }

  async function toggle(id: string, unread: boolean) {
    const willOpen = !opened.has(id);
    setOpened((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(id);
      else next.delete(id);
      return next;
    });
    if (!willOpen || !shouldMarkRead({ id, unread }, inFlight.current)) return;
    inFlight.current.add(id);
    // One read mark is one action with its own Idempotency-Key. If it fails the message simply stays marked as new.
    const result = await servicing.markReminderRead(id, newActionKey());
    inFlight.current.delete(id);
    if (result.ok) setReadNow((prev) => new Set(prev).add(id));
  }

  const models = state.data.items.map((reminder) => reminderModel(reminder, language, readNow));
  return (
    <ScrollScreen>
      <Heading>{t('reminders.title')}</Heading>
      <Body muted>{t('reminders.intro')}</Body>
      {models.length === 0 ? <Banner tone="info">{t('reminders.empty')}</Banner> : null}
      {models.map((model) => {
        const isOpen = opened.has(model.id);
        return (
          <Card key={model.id}>
            {model.unread ? <Label>{t('reminders.unread')}</Label> : null}
            <Label>{tx(model.lender)}</Label>
            <Body>{tx(model.kind)}</Body>
            <Body muted>{tx(model.due)}</Body>
            <Body muted>{tx(model.sent)}</Body>
            {isOpen ? <Body>{model.message}</Body> : null}
            <Button
              title={isOpen ? t('reminders.hide') : t('reminders.open')}
              secondary
              onPress={() => void toggle(model.id, model.unread)}
            />
            {isOpen ? (
              <Button
                title={t('reminders.goToLoan')}
                secondary
                onPress={() =>
                  router.push({ pathname: '/loans/[id]', params: { id: model.loanId } })
                }
              />
            ) : null}
          </Card>
        );
      })}
      <Button title={t('common.back')} secondary onPress={() => router.back()} />
    </ScrollScreen>
  );
}
