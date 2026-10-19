import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useBorrower } from '../../src/borrower/BorrowerProvider';
import { errorKey } from '../../src/borrower/errors';
import { LANGUAGES, type Language } from '../../src/i18n';
import { useI18n } from '../../src/i18n/I18nProvider';
import {
  Banner,
  Body,
  Button,
  Choice,
  ErrorState,
  Field,
  Heading,
  Loading,
  ScrollScreen,
} from '../../src/ui/kit';

const NAME = /^[^<>]{1,60}$/;

export default function ProfileScreen() {
  const router = useRouter();
  const { t, language } = useI18n();
  const { client, meState, refresh, changeLanguage } = useBorrower();
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (meState.kind === 'loading') return <Loading label={t('common.loading')} />;
  if (meState.kind === 'error')
    return (
      <ScrollScreen>
        <ErrorState
          message={t(errorKey(meState.code))}
          retryLabel={t('common.retry')}
          onRetry={() => void refresh()}
        />
      </ScrollScreen>
    );

  // The name field starts from the saved name but is owned by this screen, so a language switch keeps what was typed.
  const shown = name ?? meState.me.profile.displayName ?? '';
  const trimmed = shown.trim();
  const invalid = trimmed.length > 0 && !NAME.test(trimmed);

  async function finish() {
    setBusy(true);
    setError(null);
    const saved = await client.updateProfile({ displayName: trimmed.length > 0 ? trimmed : null });
    if (!saved.ok) return fail(saved.code);
    const done = await client.completeProfile();
    if (!done.ok) return fail(done.code);
    await refresh();
    setBusy(false);
    router.replace('/');
  }
  function fail(code: string) {
    setBusy(false);
    setError(t(errorKey(code)));
  }

  return (
    <ScrollScreen>
      <Heading>{t('profile.title')}</Heading>
      <Body muted>{t('profile.intro')}</Body>
      <Field
        label={t('profile.nameLabel')}
        value={shown}
        onChangeText={setName}
        maxLength={60}
        autoComplete="name"
        error={invalid ? t('profile.nameInvalid') : null}
        editable={!busy}
      />
      <Body>{t('profile.languageLabel')}</Body>
      {LANGUAGES.map((code: Language) => (
        <Choice
          key={code}
          label={t(`language.${code}`)}
          selected={language === code}
          onPress={() => void changeLanguage(code)}
        />
      ))}
      {language === 'hi' ? <Banner tone="info">{t('language.hiNote')}</Banner> : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <Button
        title={t('profile.finish')}
        onPress={() => void finish()}
        busy={busy}
        disabled={invalid}
      />
    </ScrollScreen>
  );
}
