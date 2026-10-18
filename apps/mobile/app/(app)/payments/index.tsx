import { useRouter } from 'expo-router';
import { mandateListItemView } from '../../../src/borrower/mandates-view';
import { payErrorKey } from '../../../src/borrower/payments-errors';
import { type Word } from '../../../src/borrower/payments-view';
import { useLoad } from '../../../src/borrower/useLoad';
import { useMandatesClient } from '../../../src/borrower/usePayments';
import { useI18n } from '../../../src/i18n/I18nProvider';
import {
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
 * The borrower's auto-pay mandates, one card each, with the status exactly as the provider-confirmed history last left it. Paying
 * and setting up a mandate start from a loan (the loan screens link to /payments/pay and /payments/mandate-setup with the loan).
 */
export default function PaymentsIndex() {
  const router = useRouter();
  const { t } = useI18n();
  const client = useMandatesClient();
  const say = (w: Word) => t(w.key, w.vars);
  const { state, reload } = useLoad(() => client.mandates(), [client]);

  if (state.kind === 'loading') return <Loading label={t('common.loading')} />;
  if (state.kind === 'error') {
    return (
      <ScrollScreen>
        <Heading>{t('mandate.list.title')}</Heading>
        <ErrorState
          message={t(payErrorKey(state.code))}
          retryLabel={t('common.retry')}
          onRetry={reload}
        />
        <Button title={t('common.back')} secondary onPress={() => router.back()} />
      </ScrollScreen>
    );
  }

  const items = state.data.items.map(mandateListItemView);
  return (
    <ScrollScreen>
      <Heading>{t('mandate.list.title')}</Heading>
      <Body muted>{t('mandate.list.intro')}</Body>
      {items.length === 0 ? <Body>{t('mandate.list.empty')}</Body> : null}
      {items.map((m) => (
        <Card key={m.id}>
          <Label>{m.lender}</Label>
          <Body>{say(m.rail)}</Body>
          <Body>{say(m.headline)}</Body>
          {m.account ? <Body muted>{say(m.account)}</Body> : null}
          <Button
            title={say(m.open)}
            secondary
            onPress={() =>
              router.push({ pathname: '/payments/mandate', params: { mandateId: m.id } })
            }
          />
        </Card>
      ))}
      <Button title={t('pay.refresh')} secondary onPress={reload} />
      <Button title={t('common.back')} secondary onPress={() => router.back()} />
    </ScrollScreen>
  );
}
