import { useLocalSearchParams, useRouter } from 'expo-router';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { useMemo, useReducer, useRef, useState } from 'react';
import { useBorrower } from '../../../src/borrower/BorrowerProvider';
import {
  emptyMandateDraft,
  forgetMandateDraftId,
  mandateDraftId,
  mandateDraftReducer,
  mandateSetupView,
  mandateSetupNotice,
  maskedAccountRef,
  parseDayMonthYear,
  railTitle,
  resolveMandateRequest,
  type MandateFieldErrors,
} from '../../../src/borrower/mandates-view';
import {
  needsNewMandateId,
  payErrorKey,
  refreshAfterError,
} from '../../../src/borrower/payments-errors';
import { firstParam, isUuid, newAttemptKey } from '../../../src/borrower/payments-ids';
import { ctxFor, type Word } from '../../../src/borrower/payments-view';
import { payHref } from '../../../src/borrower/servicing-view';
import { useLoad } from '../../../src/borrower/useLoad';
import { useMandatesClient } from '../../../src/borrower/usePayments';
import { useI18n } from '../../../src/i18n/I18nProvider';
import {
  Banner,
  Body,
  Button,
  Card,
  Choice,
  ErrorState,
  Field,
  Heading,
  Label,
  Loading,
  ScrollScreen,
} from '../../../src/ui/kit';

/**
 * Mandate setup. The mandate id is chosen here, BEFORE the one-time code is asked for, because the code is bound to that id. The
 * borrower types only the last four digits of the bank account; the app builds the masked reference itself, so a full account
 * number can never be typed or sent. Nothing is pre-selected. Creating the request does not set anything up: the mandate becomes
 * active only when the provider confirms it (see mandate.tsx).
 *
 * The form is offered only when the borrower's device-integrity level is one the API accepts for a mandate ('device' or 'strong').
 * This version of the app cannot raise that level, so today every borrower sees a plain notice instead, with the one-time payment
 * route (see `canOfferMandateSetup` in mandates-view.ts and the notes in docs/specs/08a-notes/fixes-M.md).
 */
export default function MandateSetupScreen() {
  const params = useLocalSearchParams<{ loanId?: string | string[] }>();
  const router = useRouter();
  const { t } = useI18n();
  const loanId = firstParam(params.loanId);
  if (!isUuid(loanId)) {
    return (
      <ScrollScreen>
        <Heading>{t('mandate.setup.title')}</Heading>
        <Banner tone="danger">{t('error.invalidInput')}</Banner>
        <Button title={t('common.back')} secondary onPress={() => router.back()} />
      </ScrollScreen>
    );
  }
  return <SetupBody key={loanId} loanId={loanId} />;
}

function SetupBody({ loanId }: { loanId: string }) {
  usePreventScreenCapture();
  const router = useRouter();
  const { t, language } = useI18n();
  const client = useMandatesClient();
  const { meState, refresh: reloadMe } = useBorrower();
  const ctx = useMemo(() => ctxFor(language), [language]);
  const say = (w: Word) => t(w.key, w.vars);
  const { state, reload } = useLoad(() => client.mandateOptions(loanId), [client, loanId]);
  const [draft, dispatch] = useReducer(mandateDraftReducer, undefined, emptyMandateDraft);
  const [mandateId, setMandateId] = useState(() => mandateDraftId(loanId));
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const inFlight = useRef(false);

  const view = useMemo(
    () => (state.kind === 'ready' ? mandateSetupView(state.data, ctx) : null),
    [state, ctx],
  );

  if (state.kind === 'loading' || meState.kind === 'loading') {
    return <Loading label={t('common.loading')} />;
  }
  if (state.kind === 'error' || view === null) {
    return (
      <ScrollScreen>
        <Heading>{t('mandate.setup.title')}</Heading>
        <ErrorState
          message={t(payErrorKey(state.kind === 'error' ? state.code : 'bad_response'))}
          retryLabel={t('common.retry')}
          onRetry={reload}
        />
        <Button title={t('common.back')} secondary onPress={() => router.back()} />
      </ScrollScreen>
    );
  }

  const resolution = resolveMandateRequest(
    draft,
    mandateId,
    view.rails.map((r) => r.rail),
  );
  const errors: MandateFieldErrors = attempted && !resolution.ok ? resolution.errors : {};
  const rail = view.rails.find((r) => r.rail === draft.rail);
  const masked = maskedAccountRef(draft.lastFour);
  const start = parseDayMonthYear(draft.startText);
  const end = parseDayMonthYear(draft.endText);
  const maxForRail =
    state.kind === 'ready'
      ? state.data.rails.find((r) => r.rail === draft.rail)?.maxAmountMinor
      : undefined;

  async function send() {
    setAttempted(true);
    if (!resolution.ok || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setErrorCode(null);
    const key = draft.attemptKey ?? newAttemptKey();
    if (draft.attemptKey === null) dispatch({ type: 'key', key });
    const result = await client.requestMandate(loanId, resolution.body, key);
    inFlight.current = false;
    setBusy(false);
    if (!result.ok) {
      setErrorCode(result.code);
      if (needsNewMandateId(result.code)) {
        // The old id cannot be used again, and neither can the code bound to it: the next try starts with a new id.
        forgetMandateDraftId(loanId);
        setMandateId(mandateDraftId(loanId));
      }
      if (refreshAfterError(result.code)) reload();
      return;
    }
    forgetMandateDraftId(loanId);
    router.replace({ pathname: '/payments/mandate', params: { mandateId: result.data.id } });
  }

  const level = meState.kind === 'ready' ? meState.me.integrityLevel : null;
  const notice = mandateSetupNotice(level);
  const offerable = view.unavailable === null && view.existingMandateId === null;
  const available = offerable && level !== null && notice === null;

  return (
    <ScrollScreen>
      <Heading>{t('mandate.setup.title')}</Heading>
      <Body>{t('mandate.lender', { lender: view.lender })}</Body>

      {view.existingMandateId ? (
        <>
          <Banner tone="info">{t('mandate.setup.existing')}</Banner>
          <Button
            title={t('mandate.setup.viewExisting')}
            onPress={() =>
              router.replace({
                pathname: '/payments/mandate',
                params: { mandateId: view.existingMandateId },
              })
            }
          />
        </>
      ) : null}
      {view.unavailable && view.existingMandateId === null ? (
        <Banner tone="warning">{say(view.unavailable)}</Banner>
      ) : null}

      {offerable && meState.kind === 'error' ? (
        <ErrorState
          message={t(payErrorKey(meState.code))}
          retryLabel={t('common.retry')}
          onRetry={() => void reloadMe()}
        />
      ) : null}
      {offerable && notice ? (
        <>
          <Banner tone="info">{say(notice)}</Banner>
          <Button
            title={t('mandate.setup.payOnce')}
            onPress={() => router.replace(payHref(loanId))}
          />
        </>
      ) : null}

      {available ? (
        <>
          <Body>{t('mandate.setup.intro', { lender: view.lender })}</Body>
          {view.requirement ? <Body muted>{say(view.requirement)}</Body> : null}
          <Body muted>{say(view.lead)}</Body>

          <Label>{t('mandate.setup.rails')}</Label>
          <Body muted>{t('mandate.setup.railsNote')}</Body>
          {view.rails.map((r) => (
            <Choice
              key={r.rail}
              label={say(r.title)}
              detail={[say(r.effect), say(r.max), say(r.maxNote), r.afa ? say(r.afa) : null]
                .filter((line): line is string => line !== null)
                .join('\n')}
              selected={draft.rail === r.rail}
              onPress={() => dispatch({ type: 'rail', rail: r.rail })}
            />
          ))}
          {errors.rail ? <Banner tone="warning">{say(errors.rail)}</Banner> : null}

          <Field
            label={t('mandate.start')}
            value={draft.startText}
            onChangeText={(text) => dispatch({ type: 'start', text })}
            placeholder={t('mandate.dateHint')}
            keyboardType="numbers-and-punctuation"
            maxLength={10}
            autoComplete="off"
            error={errors.start ? say(errors.start) : null}
          />
          <Field
            label={t('mandate.end')}
            value={draft.endText}
            onChangeText={(text) => dispatch({ type: 'end', text })}
            placeholder={t('mandate.dateHint')}
            keyboardType="numbers-and-punctuation"
            maxLength={10}
            autoComplete="off"
            error={errors.end ? say(errors.end) : null}
          />
          <Body muted>{t('mandate.dates.note')}</Body>

          <Field
            label={t('mandate.account.label')}
            value={draft.lastFour}
            onChangeText={(text) => dispatch({ type: 'account', text })}
            keyboardType="number-pad"
            maxLength={4}
            autoComplete="off"
            importantForAutofill="no"
            textContentType="none"
            error={errors.account ? say(errors.account) : null}
          />
          <Body muted>{t('mandate.account.hint')}</Body>
          {masked ? <Body muted>{t('mandate.account.preview', { account: masked })}</Body> : null}

          <Card>
            <Label>{t('mandate.step.title')}</Label>
            <Body muted>{t('mandate.step.note')}</Body>
            <Button
              title={t('mandate.step.button')}
              secondary
              onPress={() =>
                router.push({
                  pathname: '/stepup',
                  params: { action: 'mandate_creation', contextRef: mandateId },
                })
              }
            />
          </Card>

          <Card>
            <Label>{t('mandate.send.title')}</Label>
            {resolution.ok && rail && maxForRail !== undefined && start && end && masked ? (
              <Body>
                {t('mandate.summary', {
                  rail: say(railTitle(draft.rail ?? '')),
                  amount: ctx.rupees(maxForRail),
                  start: ctx.date(start),
                  end: ctx.date(end),
                  account: masked,
                })}
              </Body>
            ) : null}
            {errorCode ? <Banner tone="danger">{t(payErrorKey(errorCode))}</Banner> : null}
            <Button
              title={busy ? t('mandate.creating') : t('mandate.create')}
              busy={busy}
              onPress={() => void send()}
            />
          </Card>
        </>
      ) : null}
      <Button title={t('common.back')} secondary onPress={() => router.back()} />
    </ScrollScreen>
  );
}
