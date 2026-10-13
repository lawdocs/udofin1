// Fails the build if the resolved Expo config breaks the app's permission and release policy.
// Runs against the production configuration in CI (APP_ENV=production).
import { execFileSync } from 'node:child_process';

const raw = execFileSync('npx', ['expo', 'config', '--type', 'public', '--json'], {
  encoding: 'utf8',
  env: { ...process.env, APP_ENV: process.env.APP_ENV ?? 'production' },
});
const config = JSON.parse(raw);
const problems = [];

// No runtime permissions are declared by default (see docs/security/mobile-permissions.md).
if ((config.android?.permissions ?? []).length > 0) {
  problems.push(
    `android.permissions must be empty, found: ${config.android.permissions.join(', ')}`,
  );
}

// Permissions barred by RBI's digital-lending device-access rules or Google Play's personal-loan
// policy must stay blocked even if a library adds them.
const mustBlock = [
  'android.permission.READ_CONTACTS',
  'android.permission.READ_SMS',
  'android.permission.RECEIVE_SMS',
  'android.permission.READ_CALL_LOG',
  'android.permission.READ_PHONE_NUMBERS',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.QUERY_ALL_PACKAGES',
];
const blocked = new Set(config.android?.blockedPermissions ?? []);
for (const permission of mustBlock) {
  if (!blocked.has(permission))
    problems.push(`${permission} must be in android.blockedPermissions`);
}

if (config.updates?.enabled !== false) {
  problems.push('over-the-air updates must stay disabled until a release policy is approved');
}
if (config.android?.allowBackup !== false) {
  problems.push('android.allowBackup must be false (no cloud backup of app data)');
}
if (
  process.env.APP_ENV === 'production' &&
  /\.(local|staging|development|test)$/.test(config.android?.package ?? '')
) {
  problems.push('production build must not use a non-production application id');
}

if (problems.length > 0) {
  process.stderr.write(`Mobile config check failed:\n - ${problems.join('\n - ')}\n`);
  process.exit(1);
}
process.stdout.write(
  `Mobile config OK (${blocked.size} permissions blocked, OTA disabled, no declared permissions).\n`,
);
