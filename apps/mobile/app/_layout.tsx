import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../src/auth/AuthProvider';
import { I18nProvider, useI18n } from '../src/i18n/I18nProvider';
import { useTheme } from '../src/theme';
import { Banner, Body, Heading, Loading, Screen } from '../src/ui/kit';

function Navigator() {
  const theme = useTheme();
  const { t } = useI18n();
  const { state } = useAuth();
  if (state.status === 'loading') return <Loading label={t('common.loading')} />;
  const signedIn = state.status === 'signed_in';
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.color.background },
      }}
    >
      {/* Route protection is a convenience for the user; the API authorises every call on the server. */}
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
    </Stack>
  );
}

function ConfigProblem() {
  const { t } = useI18n();
  return (
    <Screen>
      <Heading>{t('error.generic')}</Heading>
      <Banner tone="danger">{t('error.badResponse')}</Banner>
      <Body muted>Udofin</Body>
    </Screen>
  );
}

export default function RootLayout() {
  const theme = useTheme();
  return (
    <I18nProvider>
      <SafeAreaProvider>
        <StatusBar style={theme.mode === 'dark' ? 'light' : 'dark'} />
        <AuthProvider fallback={() => <ConfigProblem />}>
          <Navigator />
        </AuthProvider>
      </SafeAreaProvider>
    </I18nProvider>
  );
}
