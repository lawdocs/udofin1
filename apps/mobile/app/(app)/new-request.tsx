import { type BorrowerProduct } from '@udofin/contracts';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useBorrower } from '../../src/borrower/BorrowerProvider';
import { errorKey } from '../../src/borrower/errors';
import { formatDate } from '../../src/borrower/format';
import { newIdempotencyKey } from '../../src/borrower/form';
import { nextStep } from '../../src/borrower/journey';
import { formatRupees, parseRupees } from '../../src/borrower/money';
import { daysToMonths, parseMonths } from '../../src/borrower/tenure';
import { useLoad } from '../../src/borrower/useLoad';
import { useI18n } from '../../src/i18n/I18nProvider';
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
} from '../../src/ui/kit';

const STEPS = 4;

/**
 * Loan request wizard: category and visible products, purpose, amount and period, review. The form lives in
 * BorrowerProvider, so leaving the screen or switching language keeps every field. The server draft is saved
 * on request and before sending; it expires 30 days after creation and editing never extends that.
 */
export default function NewRequestScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ draft?: string }>();
  const { t, language } = useI18n();
  const { client, meState, refresh, form, dispatch } = useBorrower();
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState<'save' | 'submit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const categories = useLoad(() => client.categories(), [client]);
  const products = useLoad(() => client.products(), [client]);
  const purposes = useLoad(() => client.purposes(language), [client, language]);

  // Open an existing draft for editing (once).
  const draftParam = params.draft;
  useEffect(() => {
    if (!draftParam || form.draftId === draftParam) return;
    void client.request(draftParam).then((result) => {
      if (!result.ok) return setError(t(errorKey(result.code)));
      const r = result.data.request;
      if (r.status !== 'draft') return setError(t('error.notEditable'));
      dispatch({
        type: 'loaded',
        form: {
          categoryKey: r.categoryKey,
          purposeCode: r.purposeCode,
          amountText: formatRupees(r.amountMinor).replace(/,/g, ''),
          monthsText: String(daysToMonths(r.tenureDays)),
          productVersionId: r.productVersionId,
          draftId: r.id,
          draftVersion: r.version,
        },
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftParam, client]);

  const category =
    categories.state.kind === 'ready'
      ? categories.state.data.items.find((c) => c.key === form.categoryKey)
      : undefined;
  const amount = useMemo(() => parseRupees(form.amountText), [form.amountText]);
  const tenure = useMemo(
    () => parseMonths(form.monthsText, category?.minTenureDays ?? 1),
    [form.monthsText, category],
  );
  const visibleProducts: BorrowerProduct[] =
    products.state.kind === 'ready'
      ? products.state.data.items.filter((p) => p.categoryKey === form.categoryKey)
      : [];

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

  const next = nextStep(meState.me);
  if (next === 'profile' || next === 'consents' || next === 'closing' || next === 'closed') {
    return (
      <ScrollScreen>
        <Heading>{t('request.title')}</Heading>
        <Banner tone="warning">
          {next === 'profile'
            ? t('request.profileFirst')
            : next === 'consents'
              ? t('request.consentsFirst')
              : next === 'closing'
                ? t('error.accountClosing')
                : t('error.accountClosed')}
        </Banner>
        {next === 'profile' ? (
          <Button title={t('home.continueSetup')} onPress={() => router.push('/profile')} />
        ) : null}
        {next === 'consents' ? (
          <Button title={t('request.goConsents')} onPress={() => router.push('/consent')} />
        ) : null}
      </ScrollScreen>
    );
  }

  if (sent) {
    return (
      <ScrollScreen>
        <Heading>{t('request.confirmTitle')}</Heading>
        <Banner tone="info">{t('request.confirmBody', { ref: sent })}</Banner>
        <Button
          title={t('request.viewRequests')}
          onPress={() => {
            dispatch({ type: 'reset' });
            router.replace('/requests');
          }}
        />
      </ScrollScreen>
    );
  }

  const complete = form.categoryKey !== null && form.purposeCode !== null && amount.ok && tenure.ok;

  async function saveDraft(): Promise<{ id: string; version: number } | null> {
    if (!complete || !form.categoryKey || !form.purposeCode || !amount.ok || !tenure.ok)
      return null;
    setBusy('save');
    setError(null);
    const productPart = form.productVersionId ? { productVersionId: form.productVersionId } : {};
    if (!form.draftId || form.draftVersion === null) {
      const created = await client.createRequest({
        categoryKey: form.categoryKey,
        amountMinor: amount.paise,
        tenureDays: tenure.days,
        purposeCode: form.purposeCode,
        ...productPart,
      });
      if (!created.ok) return failed(created.code);
      dispatch({ type: 'saved', id: created.data.id, version: created.data.version });
      return created.data;
    }
    const updated = await client.updateDraft(form.draftId, {
      expectedVersion: form.draftVersion,
      amountMinor: amount.paise,
      tenureDays: tenure.days,
      purposeCode: form.purposeCode,
      ...(form.productVersionId
        ? { productVersionId: form.productVersionId }
        : { clearProduct: true }),
    });
    if (!updated.ok) return failed(updated.code, form.draftId);
    dispatch({ type: 'saved', id: updated.data.id, version: updated.data.version });
    return updated.data;
  }

  function failed(code: string, reloadId?: string): null {
    setBusy(null);
    setError(t(errorKey(code)));
    // Only a lost connection leaves the outcome unknown (retry with the same key); any answer ends the attempt.
    if (code !== 'network_error') dispatch({ type: 'submitKey', key: null });
    if (code === 'version_conflict' && reloadId) {
      // Someone (another device) changed it: reload the latest version so the next try is safe.
      void client.request(reloadId).then((r) => {
        if (r.ok)
          dispatch({ type: 'saved', id: r.data.request.id, version: r.data.request.version });
      });
    }
    return null;
  }

  async function onSave() {
    const saved = await saveDraft();
    setBusy(null);
    if (saved) {
      await refresh();
      const detail = await client.request(saved.id);
      const expires =
        detail.ok && detail.data.request.expiresAt
          ? formatDate(detail.data.request.expiresAt, language)
          : '';
      setNotice(t('request.draftSaved', { date: expires }));
    }
  }

  async function onSubmit() {
    // A retry of an attempt whose answer was lost reuses the same saved version and key, so it is the
    // same operation to the server (a replay), not a second edit of a draft that may already be sent.
    const retry = form.submitKey !== null && form.draftId !== null && form.draftVersion !== null;
    const saved = retry
      ? { id: form.draftId ?? '', version: form.draftVersion ?? 0 }
      : await saveDraft();
    if (!saved) return;
    setBusy('submit');
    const key = form.submitKey ?? newIdempotencyKey();
    if (!retry) dispatch({ type: 'submitKey', key });
    const result = await client.submit(saved.id, saved.version, key);
    setBusy(null);
    if (!result.ok) return failed(result.code, saved.id);
    await refresh();
    setSent(result.data.submissionReference);
  }

  const labelOf = (key: string | null) =>
    purposes.state.kind === 'ready'
      ? (purposes.state.data.items.find((p) => p.key === key)?.label ?? '')
      : '';

  return (
    <ScrollScreen>
      <Heading>{t('request.title')}</Heading>
      <Body muted>{t('request.step', { n: step, total: STEPS })}</Body>
      <Banner tone="info">{t('request.disclaimer')}</Banner>

      {step === 1 ? (
        <>
          <Label>{t('request.category')}</Label>
          {categories.state.kind === 'loading' ? <Loading label={t('common.loading')} /> : null}
          {categories.state.kind === 'error' ? (
            <ErrorState
              message={t(errorKey(categories.state.code))}
              retryLabel={t('common.retry')}
              onRetry={categories.reload}
            />
          ) : null}
          {categories.state.kind === 'ready' && categories.state.data.items.length === 0 ? (
            <Banner tone="warning">{t('request.categoryNone')}</Banner>
          ) : null}
          {categories.state.kind === 'ready'
            ? categories.state.data.items.map((c) => (
                <Choice
                  key={c.key}
                  label={c.name}
                  selected={form.categoryKey === c.key}
                  onPress={() =>
                    !form.draftId && dispatch({ type: 'set', field: 'categoryKey', value: c.key })
                  }
                />
              ))
            : null}
          {form.categoryKey ? (
            <>
              <Label>{t('request.products')}</Label>
              {products.state.kind === 'error' ? (
                <ErrorState
                  message={t(errorKey(products.state.code))}
                  retryLabel={t('common.retry')}
                  onRetry={products.reload}
                />
              ) : null}
              {products.state.kind === 'ready' && visibleProducts.length === 0 ? (
                <Body muted>{t('request.productsNone')}</Body>
              ) : null}
              {visibleProducts.map((p) => (
                <Choice
                  key={p.versionId}
                  label={p.name}
                  detail={t('request.productRange', {
                    min: formatRupees(p.minAmountMinor),
                    max: formatRupees(p.maxAmountMinor),
                    minMonths: daysToMonths(p.minTenureDays),
                    maxMonths: daysToMonths(p.maxTenureDays),
                  })}
                  selected={form.productVersionId === p.versionId}
                  onPress={() =>
                    dispatch({
                      type: 'set',
                      field: 'productVersionId',
                      value: form.productVersionId === p.versionId ? null : p.versionId,
                    })
                  }
                />
              ))}
              {visibleProducts.length > 0 ? <Body muted>{t('request.productsNote')}</Body> : null}
            </>
          ) : null}
        </>
      ) : null}

      {step === 2 ? (
        <>
          <Label>{t('request.purpose')}</Label>
          {purposes.state.kind === 'loading' ? <Loading label={t('common.loading')} /> : null}
          {purposes.state.kind === 'error' ? (
            <ErrorState
              message={t(errorKey(purposes.state.code))}
              retryLabel={t('common.retry')}
              onRetry={purposes.reload}
            />
          ) : null}
          {purposes.state.kind === 'ready'
            ? purposes.state.data.items.map((p) => (
                <Choice
                  key={p.key}
                  label={p.label}
                  detail={
                    p.labelStatus === 'requires_review' ? t('common.requiresReview') : undefined
                  }
                  selected={form.purposeCode === p.key}
                  onPress={() => dispatch({ type: 'set', field: 'purposeCode', value: p.key })}
                />
              ))
            : null}
        </>
      ) : null}

      {step === 3 ? (
        <>
          <Field
            label={t('request.amount')}
            value={form.amountText}
            onChangeText={(v) => dispatch({ type: 'set', field: 'amountText', value: v })}
            keyboardType="decimal-pad"
            placeholder={t('request.amountHint')}
            error={
              form.amountText.length > 0 && !amount.ok
                ? t(
                    amount.error === 'too_large'
                      ? 'request.amountTooLarge'
                      : amount.error === 'too_small'
                        ? 'request.amountTooSmall'
                        : 'request.amountInvalid',
                  )
                : null
            }
          />
          <Field
            label={t('request.tenure')}
            value={form.monthsText}
            onChangeText={(v) => dispatch({ type: 'set', field: 'monthsText', value: v })}
            keyboardType="number-pad"
            placeholder={t('request.tenureHint')}
            maxLength={3}
            error={
              form.monthsText.length > 0 && !tenure.ok
                ? tenure.error === 'too_short'
                  ? t('request.tenureTooShort', { min: category?.minTenureDays ?? 1 })
                  : t(
                      tenure.error === 'too_long'
                        ? 'request.tenureTooLong'
                        : 'request.tenureInvalid',
                    )
                : null
            }
          />
          {tenure.ok ? <Body muted>{t('request.tenureDays', { days: tenure.days })}</Body> : null}
        </>
      ) : null}

      {step === 4 ? (
        <Card>
          <Label>{t('request.review')}</Label>
          <Body>{category?.name ?? ''}</Body>
          <Body>{labelOf(form.purposeCode)}</Body>
          <Body>
            {amount.ok ? t('requests.amount', { amount: formatRupees(amount.paise) }) : ''}
          </Body>
          <Body>{tenure.ok ? t('requests.tenure', { days: tenure.days }) : ''}</Body>
          {form.productVersionId ? <Body muted>{t('request.productPicked')}</Body> : null}
          <Body muted>{t('request.disclaimer')}</Body>
        </Card>
      ) : null}

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}

      {step > 1 ? (
        <Button title={t('common.back')} secondary onPress={() => setStep(step - 1)} />
      ) : null}
      {step < STEPS ? (
        <Button
          title={t('common.next')}
          onPress={() => setStep(step + 1)}
          disabled={
            (step === 1 && !form.categoryKey) ||
            (step === 2 && !form.purposeCode) ||
            (step === 3 && !(amount.ok && tenure.ok))
          }
        />
      ) : (
        <>
          <Button
            title={busy === 'submit' ? t('request.submitting') : t('request.submit')}
            onPress={() => void onSubmit()}
            busy={busy === 'submit'}
            disabled={!complete || busy !== null}
          />
          <Button
            title={t('request.saveDraft')}
            secondary
            onPress={() => void onSave()}
            busy={busy === 'save'}
            disabled={!complete || busy !== null}
          />
        </>
      )}
    </ScrollScreen>
  );
}
