import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useReducer, useRef, useState } from 'react';
import { View } from 'react-native';
import { payErrorKey, refreshAfterError } from '../../../src/borrower/payments-errors';
import { firstParam, isUuid, newAttemptKey } from '../../../src/borrower/payments-ids';
import {
  ctxFor,
  emptyPayDraft,
  payDraftReducer,
  payOptionsView,
  resolvePayment,
  type OptionView,
  type Word,
} from '../../../src/borrower/payments-view';
import { useLoad } from '../../../src/borrower/useLoad';
import { usePaymentsClient } from '../../../src/borrower/usePayments';
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
 * Pay: what the lender allows, in the lender's own figures. Nothing is pre-selected; the borrower chooses what to pay and starts
 * the payment on purpose. Amounts are shown as the API states them or typed within the limits the API shows, as exact paise.
 * The payment itself is made on the payment provider's page (see status.tsx); this screen never says anything was paid.
 */
export default function PayScreen() {
  const params = useLocalSearchParams<{
    loanId?: string | string[];
    purpose?: string | string[];
  }>();
  const router = useRouter();
  const { t } = useI18n();
  const loanId = firstParam(params.loanId);
  if (!isUuid(loanId)) {
    return (
      <ScrollScreen>
        <Heading>{t('pay.title')}</Heading>
        <Banner tone="danger">{t('error.invalidInput')}</Banner>
        <Button title={t('common.back')} secondary onPress={() => router.back()} />
      </ScrollScreen>
    );
  }
  return <PayBody key={loanId} loanId={loanId} hint={firstParam(params.purpose)} />;
}

function PayBody({ loanId, hint }: { loanId: string; hint: string | undefined }) {
  const router = useRouter();
  const { t, language } = useI18n();
  const client = usePaymentsClient();
  const ctx = useMemo(() => ctxFor(language), [language]);
  const say = (w: Word) => t(w.key, w.vars);
  const { state, reload } = useLoad(() => client.paymentOptions(loanId), [client, loanId]);
  const [draft, dispatch] = useReducer(payDraftReducer, undefined, emptyPayDraft);
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const inFlight = useRef(false);

  const view = useMemo(
    () => (state.kind === 'ready' ? payOptionsView(state.data, ctx, hint) : null),
    [state, ctx, hint],
  );

  if (state.kind === 'loading') return <Loading label={t('common.loading')} />;
  if (state.kind === 'error' || view === null) {
    return (
      <ScrollScreen>
        <Heading>{t('pay.title')}</Heading>
        <ErrorState
          message={t(payErrorKey(state.kind === 'error' ? state.code : 'bad_response'))}
          retryLabel={t('common.retry')}
          onRetry={reload}
        />
        <Button title={t('common.back')} secondary onPress={() => router.back()} />
      </ScrollScreen>
    );
  }

  const chosen: OptionView | undefined = view.options.find((o) => o.purpose === draft.purpose);
  const resolution = resolvePayment(chosen, draft, ctx);

  async function start() {
    if (!resolution.ok || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setErrorCode(null);
    // One key per content: a retry of the same request repeats the key, a changed request gets a new one.
    const key = draft.attemptKey ?? newAttemptKey();
    if (draft.attemptKey === null) dispatch({ type: 'key', key });
    const result = await client.requestPayment(loanId, resolution.request, key);
    inFlight.current = false;
    setBusy(false);
    if (!result.ok) {
      setErrorCode(result.code);
      if (refreshAfterError(result.code)) reload();
      return;
    }
    router.replace({ pathname: '/payments/status', params: { paymentId: result.data.id } });
  }

  return (
    <ScrollScreen>
      <Heading>{t('pay.title')}</Heading>
      <Body>{t('pay.intro', { lender: view.lender })}</Body>
      <Body>{t('pay.lender', { lender: view.lender })}</Body>
      {view.destination ? <Body>{say(view.destination)}</Body> : null}
      {view.reported ? <Body muted>{say(view.reported)}</Body> : null}
      {view.notice ? <Banner tone={view.notice.tone}>{say(view.notice.word)}</Banner> : null}
      {view.unavailable ? <Banner tone="warning">{say(view.unavailable)}</Banner> : null}

      {view.openPayments.length > 0 ? (
        <Card>
          <Label>{t('pay.open.title')}</Label>
          <Body muted>{t('pay.open.note')}</Body>
          {view.openPayments.map((p) => (
            <View key={p.id} style={{ gap: 8 }}>
              <Body>{t('pay.open.item', { purpose: say(p.title), status: say(p.status) })}</Body>
              <Button
                title={say(p.open)}
                secondary
                onPress={() =>
                  router.push({ pathname: '/payments/status', params: { paymentId: p.id } })
                }
              />
            </View>
          ))}
        </Card>
      ) : null}

      {view.noneOffered ? <Banner tone="info">{say(view.noneOffered)}</Banner> : null}

      {view.options.length > 0 ? (
        <>
          <Label>{t('pay.choose')}</Label>
          <Body muted>{t('pay.chooseNote')}</Body>
          {view.options.map((o) => (
            <View key={o.purpose} style={{ gap: 8 }}>
              <Choice
                label={say(o.title)}
                detail={say(o.source)}
                selected={draft.purpose === o.purpose}
                onPress={() => dispatch({ type: 'purpose', purpose: o.purpose })}
              />
              {o.due ? <Body muted>{say(o.due)}</Body> : null}
              {o.partial ? <Body muted>{say(o.partial)}</Body> : null}
              {o.quote ? <Body muted>{say(o.quote.validUntil)}</Body> : null}
              {o.quote?.blocked ? <Banner tone="warning">{say(o.quote.blocked)}</Banner> : null}
              {o.penal ? (
                <Card>
                  <Label>{say(o.penal.label)}</Label>
                  {/* The lender's approved sentence, exactly as returned. */}
                  <Body>{o.penal.sentence}</Body>
                  {o.penal.shownInEnglish ? (
                    <Body muted>{t('common.languageFallback')}</Body>
                  ) : null}
                </Card>
              ) : null}
            </View>
          ))}
        </>
      ) : null}

      {chosen && chosen.rule.kind === 'fixed_or_range' ? (
        <View style={{ gap: 8 }}>
          <Choice
            label={t('pay.mode.reported', {
              amount: ctx.rupees(chosen.rule.amountMinor),
              lender: view.lender,
            })}
            selected={draft.mode === 'reported'}
            onPress={() => dispatch({ type: 'mode', mode: 'reported' })}
          />
          <Choice
            label={t('pay.mode.other', { lender: view.lender })}
            selected={draft.mode === 'other'}
            onPress={() => dispatch({ type: 'mode', mode: 'other' })}
          />
        </View>
      ) : null}
      {chosen &&
      (chosen.rule.kind === 'range' ||
        (chosen.rule.kind === 'fixed_or_range' && draft.mode === 'other')) ? (
        <View style={{ gap: 8 }}>
          <Field
            label={t('pay.amountLabel')}
            value={draft.amountText}
            onChangeText={(text) => dispatch({ type: 'amount', text })}
            keyboardType="decimal-pad"
            autoComplete="off"
            maxLength={20}
            error={!resolution.ok && resolution.reason ? say(resolution.reason) : null}
          />
          <Body muted>
            {t('pay.amountHint', {
              min: ctx.rupees(chosen.rule.minMinor),
              max: ctx.rupees(chosen.rule.maxMinor),
            })}
          </Body>
        </View>
      ) : null}

      {chosen && resolution.ok ? (
        <Card>
          <Label>{t('pay.summary.title')}</Label>
          <Body>
            {t('pay.summary.line', {
              amount: ctx.rupees(resolution.amountMinor),
              purpose: say(chosen.title),
              lender: view.lender,
            })}
          </Body>
          {view.destination ? <Body muted>{say(view.destination)}</Body> : null}
          <Body muted>{t('pay.summary.next')}</Body>
        </Card>
      ) : null}

      {errorCode ? <Banner tone="danger">{t(payErrorKey(errorCode))}</Banner> : null}

      {view.options.length > 0 ? (
        <>
          {!resolution.ok && resolution.reason === null ? (
            <Body muted>{t('pay.chooseFirst')}</Body>
          ) : null}
          <Button
            title={busy ? t('pay.starting') : t('pay.start')}
            busy={busy}
            disabled={!resolution.ok}
            onPress={() => void start()}
          />
        </>
      ) : null}
      <Button title={t('common.back')} secondary onPress={() => router.back()} />
    </ScrollScreen>
  );
}
