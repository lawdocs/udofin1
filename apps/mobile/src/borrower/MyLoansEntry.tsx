import { useRouter } from 'expo-router';
import { useI18n } from '../i18n/I18nProvider';
import { Body, Button, Card } from '../ui/kit';
import { hasAnyLoan } from './servicing-view';
import { useLoad } from './useLoad';
import { useServicing } from './useServicing';

/**
 * The one entry point from the home screen into the loan screens. It appears only when the lender-reported loan list has at
 * least one loan; while loading, or when the list fails or is empty, it draws nothing and the home screen is exactly as before.
 */
export function MyLoansEntry() {
  const router = useRouter();
  const { t } = useI18n();
  const servicing = useServicing();
  const { state } = useLoad(() => servicing.loans(), [servicing]);
  if (state.kind !== 'ready' || !hasAnyLoan(state.data)) return null;
  return (
    <Card>
      <Body>{t('loans.entry.note')}</Body>
      <Button title={t('loans.entry')} onPress={() => router.push('/loans')} />
    </Card>
  );
}
