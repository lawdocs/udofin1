import { Tabs } from 'expo-router';
import { BorrowerProvider } from '../../src/borrower/BorrowerProvider';
import { useI18n } from '../../src/i18n/I18nProvider';

/**
 * The persistent menu (home, requests, settings) is always one tap away. Other screens are routes
 * without a tab. Route protection is for convenience; the API authorises every call.
 */
function Menu() {
  const { t } = useI18n();
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" options={{ title: t('common.menu.home') }} />
      <Tabs.Screen name="requests" options={{ title: t('common.menu.requests') }} />
      <Tabs.Screen name="settings" options={{ title: t('common.menu.settings') }} />
      <Tabs.Screen name="profile" options={{ href: null }} />
      <Tabs.Screen name="consent" options={{ href: null }} />
      <Tabs.Screen name="new-request" options={{ href: null }} />
      <Tabs.Screen name="stepup" options={{ href: null }} />
    </Tabs>
  );
}

export default function AppLayout() {
  return (
    <BorrowerProvider>
      <Menu />
    </BorrowerProvider>
  );
}
