import { STEPUP_ACTIONS } from '@udofin/contracts';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { useReducer, useState } from 'react';
import { errorKey } from '../../src/borrower/errors';
import { useBorrower } from '../../src/borrower/BorrowerProvider';
import { canEnterCode, stepUpReducer, type StepUpAction } from '../../src/borrower/stepup';
import { type MessageKey } from '../../src/i18n';
import { useI18n } from '../../src/i18n/I18nProvider';
import { Banner, Body, Button, Field, Heading, ScrollScreen } from '../../src/ui/kit';

/**
 * One-time-code check for sensitive actions (offer acceptance, e-sign, bank-account change, mandate). The
 * actions arrive in later phases; this screen and its states are ready. The code is bound to the action and
 * the object on the server. This is a different check from device integrity, and neither implies the other.
 */
export default function StepUpScreen() {
  usePreventScreenCapture();
  const router = useRouter();
  const params = useLocalSearchParams<{ action?: string; contextRef?: string }>();
  const { t } = useI18n();
  const { client } = useBorrower();
  const [state, dispatch] = useReducer(stepUpReducer, { kind: 'idle' });
  const [code, setCode] = useState('');

  const action = STEPUP_ACTIONS.find((a) => a === params.action);
  const contextRef = params.contextRef ?? '';
  if (!action || !/^[A-Za-z0-9_-]{1,64}$/.test(contextRef)) {
    return (
      <ScrollScreen>
        <Heading>{t('stepup.title')}</Heading>
        <Banner tone="danger">{t('error.invalidInput')}</Banner>
        <Button title={t('common.back')} secondary onPress={() => router.back()} />
      </ScrollScreen>
    );
  }

  async function start(chosen: StepUpAction) {
    dispatch({ type: 'start' });
    setCode('');
    const result = await client.startStepUp(chosen, contextRef);
    if (!result.ok) return dispatch({ type: 'error', code: result.code });
    dispatch({
      type: 'started',
      challengeId: result.data.challengeId,
      expiresAt: result.data.expiresAt,
      delivery: result.data.delivery,
    });
  }
  async function verify() {
    if (state.kind !== 'sent' && state.kind !== 'failed') return;
    const { challengeId } = state;
    dispatch({ type: 'verify' });
    const result = await client.verifyStepUp(challengeId, code.replace(/\s/g, ''));
    if (!result.ok) return dispatch({ type: 'error', code: result.code });
    dispatch({ type: 'result', result: result.data.result });
    setCode('');
  }

  return (
    <ScrollScreen>
      <Heading>{t('stepup.title')}</Heading>
      <Body>{t(`stepup.action.${action}` as MessageKey)}</Body>
      <Body muted>{t('stepup.intro')}</Body>

      {state.kind === 'idle' || state.kind === 'ended' || state.kind === 'error' ? (
        <>
          {state.kind === 'ended' ? (
            <Banner tone="warning">{t(`stepup.result.${state.result}` as MessageKey)}</Banner>
          ) : null}
          {state.kind === 'error' ? <Banner tone="danger">{t(errorKey(state.code))}</Banner> : null}
          <Button title={t('stepup.send')} onPress={() => void start(action)} />
        </>
      ) : null}
      {state.kind === 'sending' ? (
        <Button title={t('stepup.sending')} busy onPress={() => undefined} />
      ) : null}

      {state.kind === 'sent' || state.kind === 'failed' || state.kind === 'verifying' ? (
        <>
          {state.kind === 'sent' && state.delivery === 'accepted' ? (
            <Banner tone="info">{t('stepup.sent')}</Banner>
          ) : null}
          {state.kind === 'sent' && state.delivery === 'rejected' ? (
            <Banner tone="danger">{t('stepup.deliveryRejected')}</Banner>
          ) : null}
          {state.kind === 'sent' && state.delivery === 'timeout' ? (
            <Banner tone="danger">{t('stepup.deliveryTimeout')}</Banner>
          ) : null}
          {state.kind === 'sent' && state.delivery === 'not_configured' ? (
            <Banner tone="danger">{t('stepup.deliveryNotConfigured')}</Banner>
          ) : null}
          {state.kind === 'failed' ? (
            <Banner tone="warning">{t('stepup.result.invalid')}</Banner>
          ) : null}
          {canEnterCode(state) || state.kind === 'verifying' ? (
            <>
              <Field
                label={t('stepup.codeLabel')}
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="sms-otp"
                maxLength={7}
                editable={state.kind !== 'verifying'}
              />
              <Button
                title={t('stepup.verify')}
                busy={state.kind === 'verifying'}
                disabled={code.replace(/\s/g, '').length < 6}
                onPress={() => void verify()}
              />
            </>
          ) : (
            <Button title={t('common.retry')} onPress={() => void start(action)} />
          )}
        </>
      ) : null}

      {state.kind === 'verified' ? (
        <>
          <Banner tone="info">{t('stepup.result.verified')}</Banner>
          <Button title={t('common.done')} onPress={() => router.back()} />
        </>
      ) : null}
    </ScrollScreen>
  );
}
