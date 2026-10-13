import { useRouter } from 'expo-router';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { useState } from 'react';
import { useAuth } from '../../src/auth/AuthProvider';
import { OTP_MESSAGES } from '../../src/auth/otp-flow';
import { Banner, Body, Button, Field, Heading, Screen } from '../../src/ui/kit';

export default function SignInScreen() {
  usePreventScreenCapture();
  const router = useRouter();
  const { state, otp, config } = useAuth();
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    const result = await otp.requestCode(phone);
    setBusy(false);
    if (result.ok && result.phone)
      router.push({ pathname: '/verify', params: { phone: result.phone } });
    else if (!result.ok) setError(OTP_MESSAGES[result.error]);
  }

  const ended = state.status === 'signed_out' ? state.reason : 'none';
  return (
    <Screen>
      <Heading>Welcome to Udofin</Heading>
      {ended === 'expired' || ended === 'revoked' ? (
        <Banner tone="warning">Your session ended for your security. Please sign in again.</Banner>
      ) : null}
      <Body muted>Enter your mobile number. We will send you a one-time code by SMS.</Body>
      <Field
        label="Mobile number"
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
        title="Send code"
        onPress={() => void submit()}
        busy={busy}
        disabled={phone.trim().length === 0}
      />
      {config.appEnv !== 'production' ? (
        <Banner tone="info">
          {config.appEnv} build. SMS delivery needs the SMS provider (Phase 05); until then codes
          only work with a Supabase test number on a local project.
        </Banner>
      ) : null}
    </Screen>
  );
}
