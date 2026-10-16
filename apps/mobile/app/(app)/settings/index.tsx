import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useAuth } from '../../../src/auth/AuthProvider';
import { errorKey } from '../../../src/borrower/errors';
import { useBorrower } from '../../../src/borrower/BorrowerProvider';
import { LANGUAGES, type Language } from '../../../src/i18n';
import { useI18n } from '../../../src/i18n/I18nProvider';
import {
  Banner,
  Body,
  Button,
  Card,
  CheckRow,
  Choice,
  ErrorState,
  Heading,
  Label,
  Loading,
  ScrollScreen,
} from '../../../src/ui/kit';

export default function SettingsScreen() {
  const router = useRouter();
  const { signOut } = useAuth();
  const { t, language } = useI18n();
  const { client, meState, refresh, changeLanguage } = useBorrower();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (meState.kind === 'loading') return <Loading label={t('common.loading')} />;
  if (meState.kind === 'error')
    return (
      <ScrollScreen>
        <Heading>{t('settings.title')}</Heading>
        <ErrorState
          message={t(errorKey(meState.code))}
          retryLabel={t('common.retry')}
          onRetry={() => void refresh()}
        />
        <Button title={t('common.signOut')} secondary onPress={() => void signOut()} />
      </ScrollScreen>
    );

  const me = meState.me;
  async function toggleSms(next: boolean) {
    setSaving(true);
    setError(null);
    const result = await client.setServiceSms(next);
    if (!result.ok) setError(t(errorKey(result.code)));
    await refresh();
    setSaving(false);
  }

  return (
    <ScrollScreen>
      <Heading>{t('settings.title')}</Heading>
      <Card>
        <Label>{t('settings.language')}</Label>
        {LANGUAGES.map((code: Language) => (
          <Choice
            key={code}
            label={t(`language.${code}`)}
            selected={language === code}
            onPress={() => void changeLanguage(code)}
          />
        ))}
        {language === 'hi' ? <Banner tone="info">{t('language.hiNote')}</Banner> : null}
      </Card>
      <Card>
        <Label>{t('settings.communication')}</Label>
        <CheckRow
          label={t('settings.serviceSms')}
          checked={me.preferences.serviceUpdatesSms}
          disabled={saving}
          onToggle={(next) => void toggleSms(next)}
        />
        <Body muted>{t('settings.serviceSmsHelp')}</Body>
        <Label>{t('settings.marketing')}</Label>
        <Body muted>{t('settings.marketingOff')}</Body>
      </Card>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <Button title={t('settings.consents')} secondary onPress={() => router.push('/consent')} />
      <Button
        title={t('settings.deleteAccount')}
        secondary
        onPress={() => router.push('/settings/delete-account')}
      />
      <Button title={t('common.signOut')} secondary onPress={() => void signOut()} />
    </ScrollScreen>
  );
}
