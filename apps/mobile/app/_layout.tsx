import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../src/auth/AuthProvider';
import { useTheme } from '../src/theme';
import { Banner, Body, Heading, Loading, Screen } from '../src/ui/kit';

function Navigator() {
  const theme = useTheme();
  const { state } = useAuth();
  if (state.status === 'loading') return <Loading label="Starting Udofin" />;
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

export default function RootLayout() {
  const theme = useTheme();
  return (
    <SafeAreaProvider>
      <StatusBar style={theme.mode === 'dark' ? 'light' : 'dark'} />
      <AuthProvider
        fallback={() => (
          <Screen>
            <Heading>App configuration problem</Heading>
            <Banner tone="danger">
              This build is not configured correctly. Please install the latest version from the
              official store.
            </Banner>
            <Body muted>If this continues, contact support.</Body>
          </Screen>
        )}
      >
        <Navigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
