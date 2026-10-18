import { useRouter } from 'expo-router';
import { useBorrower } from '../../src/borrower/BorrowerProvider';
import { errorKey } from '../../src/borrower/errors';
import { nextStep } from '../../src/borrower/journey';
import { MyLoansEntry } from '../../src/borrower/MyLoansEntry';
import { useI18n } from '../../src/i18n/I18nProvider';
import {
  Banner,
  Body,
  Button,
  Card,
  ErrorState,
  Heading,
  Loading,
  ScrollScreen,
} from '../../src/ui/kit';

/**
 * Signed-in home for borrowers. Shows where you are in setup using separate facts from the server.
 * Nothing here says verified, eligible or approved: identity checks and decisions belong to lenders.
 */
export default function HomeScreen() {
  const router = useRouter();
  const { t } = useI18n();
  const { meState, refresh } = useBorrower();

  if (meState.kind === 'loading') return <Loading label={t('common.loading')} />;
  if (meState.kind === 'error')
    return (
      <ScrollScreen>
        <Heading>{t('home.title')}</Heading>
        <ErrorState
          message={t(errorKey(meState.code))}
          retryLabel={t('common.retry')}
          onRetry={() => void refresh()}
        />
      </ScrollScreen>
    );

  const me = meState.me;
  const step = nextStep(me);
  const name = me.profile.displayName;
  return (
    <ScrollScreen>
      <Heading>{name ? t('home.greeting', { name }) : t('home.greetingAnon')}</Heading>
      <Body muted>{t('home.role')}</Body>
      {step === 'closed' ? <Banner tone="warning">{t('home.closed')}</Banner> : null}
      {step === 'closing' ? <Banner tone="warning">{t('home.closing')}</Banner> : null}
      {step === 'profile' ? (
        <Card>
          <Body>{t('home.step.profile')}</Body>
          <Button title={t('home.continueSetup')} onPress={() => router.push('/profile')} />
        </Card>
      ) : null}
      {step === 'consents' ? (
        <Card>
          <Body>{t('home.step.consents')}</Body>
          <Button title={t('home.continueSetup')} onPress={() => router.push('/consent')} />
        </Card>
      ) : null}
      {step === 'request' ? (
        <Card>
          <Body>{t('home.step.request')}</Body>
          <Button title={t('home.newRequest')} onPress={() => router.push('/new-request')} />
        </Card>
      ) : null}
      {step !== 'closed' ? (
        <Card>
          <Body>{t('home.drafts', { count: me.journey.draftRequests })}</Body>
          <Body>{t('home.submitted', { count: me.journey.submittedRequests })}</Body>
          <Button title={t('home.myRequests')} secondary onPress={() => router.push('/requests')} />
        </Card>
      ) : null}
      <MyLoansEntry />
      <Banner tone="info">{t('home.noKyc')}</Banner>
    </ScrollScreen>
  );
}
