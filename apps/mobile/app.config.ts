import { type ConfigContext, type ExpoConfig } from 'expo/config';

/**
 * Borrower app configuration. Values that differ per environment come from APP_ENV / EXPO_PUBLIC_*.
 *
 * Permissions policy (see docs/security/mobile-permissions.md): the app declares NO runtime
 * permissions by default. Each permission is added only in the module that needs it, at the step
 * where it is needed, with a reviewed justification. Permissions that RBI's digital lending rules
 * or Google Play's personal-loan policy prohibit are stripped from the merged manifest below, even
 * if a third-party library tries to add them.
 */
// Expo types process.env loosely; coerce explicitly.
const APP_ENV = String(process.env.APP_ENV ?? 'local');
const IS_PRODUCTION = APP_ENV === 'production';

// DECISION PENDING (docs/product/open-decisions.md): final store identifiers are permanent once published.
const BUNDLE_ID = IS_PRODUCTION ? 'com.udofin.app' : `com.udofin.app.${APP_ENV}`;

const BLOCKED_ANDROID_PERMISSIONS = [
  'android.permission.READ_CONTACTS',
  'android.permission.WRITE_CONTACTS',
  'android.permission.GET_ACCOUNTS',
  'android.permission.READ_CALL_LOG',
  'android.permission.WRITE_CALL_LOG',
  'android.permission.PROCESS_OUTGOING_CALLS',
  'android.permission.READ_PHONE_STATE',
  'android.permission.READ_PHONE_NUMBERS',
  'android.permission.CALL_PHONE',
  'android.permission.READ_SMS',
  'android.permission.RECEIVE_SMS',
  'android.permission.SEND_SMS',
  'android.permission.RECEIVE_MMS',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.MANAGE_EXTERNAL_STORAGE',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.QUERY_ALL_PACKAGES',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.RECORD_AUDIO',
  'android.permission.READ_CALENDAR',
  'android.permission.WRITE_CALENDAR',
  'android.permission.BODY_SENSORS',
  'android.permission.ACTIVITY_RECOGNITION',
];

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: IS_PRODUCTION ? 'Udofin' : `Udofin (${APP_ENV})`,
  slug: 'udofin',
  scheme: 'udofin',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: BUNDLE_ID,
    supportsTablet: false,
    config: { usesNonExemptEncryption: false },
    infoPlist: {},
  },
  android: {
    package: BUNDLE_ID,
    permissions: [],
    blockedPermissions: BLOCKED_ANDROID_PERMISSIONS,
    allowBackup: false,
  },
  plugins: ['expo-router', 'expo-secure-store'],
  experiments: { typedRoutes: true },
  // Over-the-air updates stay disabled until a release policy for regulated flows is approved.
  updates: { enabled: false },
  extra: {
    appEnv: APP_ENV,
  },
});
