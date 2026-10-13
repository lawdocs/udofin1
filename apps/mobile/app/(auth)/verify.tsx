import { useLocalSearchParams, useRouter } from 'expo-router';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { useState } from 'react';
import { useAuth } from '../../src/auth/AuthProvider';
import { OTP_MESSAGES } from '../../src/auth/otp-flow';
import { maskPhone } from '../../src/auth/phone';
import { Body, Button, Field, Heading, Screen } from '../../src/ui/kit';

export default function VerifyScreen() {
  usePreventScreenCapture(); // the code and number must not end up in screenshots or the app switcher preview
  const router = useRouter();
  const { otp } = useAuth();
  const { phone } = useLocalSearchParams<{ phone: string }>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!phone) return;
    setBusy(true);
    setError(null);
    const result = await otp.verifyCode(phone, code);
    setBusy(false);
    if (!result.ok) setError(OTP_MESSAGES[result.error]); // success: the session change swaps the navigator
  }

  return (
    <Screen>
      <Heading>Enter the code</Heading>
      <Body muted>We sent a 6-digit code to {phone ? maskPhone(phone) : 'your phone'}.</Body>
      <Field
        label="6-digit code"
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
        title="Verify"
        onPress={() => void submit()}
        busy={busy}
        disabled={code.replace(/\s/g, '').length < 6}
      />
      <Button title="Use a different number" secondary onPress={() => router.back()} />
    </Screen>
  );
}
