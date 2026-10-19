import { useRouter } from 'expo-router';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { useState } from 'react';
import { useAuth } from '../../src/auth/AuthProvider';
import { LANGUAGES, type Language, type MessageKey } from '../../src/i18n';
import { useI18n } from '../../src/i18n/I18nProvider';
import { Banner, Body, Button, Choice, Field, Heading, ScrollScreen } from '../../src/ui/kit';

export default function SignInScreen() {
  usePreventScreenCapture();
  const router = useRouter();
  const { t, language, setLanguage } = useI18n();
  const { state, otp, config } = useAuth();
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    const result = await otp.requestCode(phone);
    setBusy(false);
    if (result.ok && result.phone) router.push('/verify');
    else if (!result.ok) setError(t(`otp.error.${result.error}` as MessageKey));
  }

  const ended = state.status === 'signed_out' ? state.reason : 'none';
  return (
    <ScrollScreen>
      <Heading>{t('signin.title')}</Heading>
      {ended === 'expired' || ended === 'revoked' ? (
        <Banner tone="warning">{t('signin.sessionEnded')}</Banner>
      ) : null}
      <Body>{t('signin.role')}</Body>
      {LANGUAGES.map((code: Language) => (
        <Choice
          key={code}
          label={t(`language.${code}`)}
          selected={language === code}
          onPress={() => setLanguage(code)}
        />
      ))}
      {language === 'hi' ? <Banner tone="info">{t('language.hiNote')}</Banner> : null}
      <Body muted>{t('signin.intro')}</Body>
      <Field
        label={t('signin.phoneLabel')}
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        textContentType="telephoneNumber"
        autoComplete="tel"
        placeholder="98765 43210"
        maxLength={16}
        error={error}
        editable={!busy}
      />
      <Button
        title={t('signin.send')}
        onPress={() => void submit()}
        busy={busy}
        disabled={phone.trim().length === 0}
      />
      {config.appEnv !== 'production' ? (
        <Banner tone="info">{t('signin.devBuild', { env: config.appEnv })}</Banner>
      ) : null}
    </ScrollScreen>
  );
}
