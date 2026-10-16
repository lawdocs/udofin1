import { Redirect, useRouter } from 'expo-router';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { useState } from 'react';
import { useAuth } from '../../src/auth/AuthProvider';
import { type MessageKey } from '../../src/i18n';
import { useI18n } from '../../src/i18n/I18nProvider';
import { maskPhone } from '../../src/auth/phone';
import { Body, Button, Field, Heading, Screen } from '../../src/ui/kit';

export default function VerifyScreen() {
  usePreventScreenCapture(); // the code and number must not end up in screenshots or the app switcher preview
  const router = useRouter();
  const { otp } = useAuth();
  const { t } = useI18n();
  const phone = otp.pendingPhone();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    const result = await otp.verifyCode(code);
    setBusy(false);
    if (!result.ok) setError(t(`otp.error.${result.error}` as MessageKey)); // success: the session change swaps the navigator
  }

  if (!phone) return <Redirect href="/sign-in" />; // opened directly (deep link) or after a restart: start again

  return (
    <Screen>
      <Heading>{t('otp.title')}</Heading>
      <Body muted>{t('otp.sentTo', { phone: maskPhone(phone) })}</Body>
      <Field
        label={t('otp.codeLabel')}
        value={code}
        onChangeText={setCode}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="sms-otp"
        maxLength={7}
        error={error}
        editable={!busy}
      />
      <Button
        title={t('otp.verify')}
        onPress={() => void submit()}
        busy={busy}
        disabled={code.replace(/\s/g, '').length < 6}
      />
      <Button
        title={t('otp.otherNumber')}
        secondary
        onPress={() => {
          otp.reset();
          router.back();
        }}
      />
    </Screen>
  );
}
