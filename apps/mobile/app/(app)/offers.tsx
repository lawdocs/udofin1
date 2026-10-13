import { type COMPARISON_SORTS } from '@udofin/contracts';
import * as Linking from 'expo-linking';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { errorKey } from '../../src/borrower/errors';
import { formatDate } from '../../src/borrower/format';
import { newIdempotencyKey } from '../../src/borrower/form';
import { formatRupees } from '../../src/borrower/money';
import { formatAprBps, isSafeKfsUrl } from '../../src/borrower/routing';
import { useBorrower } from '../../src/borrower/BorrowerProvider';
import { type MessageKey } from '../../src/i18n';
import { useI18n } from '../../src/i18n/I18nProvider';
import { type Comparison } from '@udofin/contracts';
import {
  Banner,
  Body,
  Button,
  Card,
  Choice,
  ErrorState,
  Heading,
  Label,
  Loading,
  ScrollScreen,
} from '../../src/ui/kit';

type Sort = (typeof COMPARISON_SORTS)[number];
type State =
  { kind: 'loading' } | { kind: 'ready'; data: Comparison } | { kind: 'error'; code: string };
const platform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'web' ? 'web' : 'android';

/**
 * Every valid offer, in the approved order, with the lender's own figures exactly as stated and a link to its Key Facts
 * Statement. No badges, no countdown, no pre-selected option, and nothing here is calculated by Udofin. Lenders that
 * did not offer are named with the real reason.
 */
export default function OffersScreen() {
  const { request } = useLocalSearchParams<{ request?: string }>();
  const requestId = request ?? '';
  const { t, language } = useI18n();
  const { client } = useBorrower();
  const [sort, setSort] = useState<Sort | undefined>(undefined);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [key, setKey] = useState(() => newIdempotencyKey());
  const [linkError, setLinkError] = useState<string | null>(null);

  // One key per deliberate view (opening the screen, changing the sort, retrying): a lost answer is retried with the same key.
  useEffect(() => {
    let cancelled = false;
    void client
      .compare(requestId, { ...(sort ? { sort } : {}), platform, language }, key)
      .then((result) => {
        if (cancelled) return;
        setState(
          result.ok ? { kind: 'ready', data: result.data } : { kind: 'error', code: result.code },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [client, requestId, sort, language, key, attempt]);

  if (state.kind === 'loading') return <Loading label={t('common.loading')} />;
  if (state.kind === 'error') {
    const message =
      state.code === 'ranking_rule_not_approved' ? t('error.rankingRule') : t(errorKey(state.code));
    return (
      <ScrollScreen>
        <Heading>{t('offers.title')}</Heading>
        <ErrorState
          message={message}
          retryLabel={t('common.retry')}
          onRetry={() => {
            setState({ kind: 'loading' });
            setAttempt((n) => n + 1);
          }}
        />
      </ScrollScreen>
    );
  }

  const data = state.data;
  const sorts: Sort[] = [
    data.rule.defaultSort[0] ?? 'apr_bps',
    ...data.rule.alternativeSorts.filter((s) => s !== data.rule.defaultSort[0]),
  ];

  async function openKfs(url: string) {
    setLinkError(null);
    if (!isSafeKfsUrl(url)) return setLinkError(t('offers.kfsUnsafe'));
    try {
      await Linking.openURL(url);
    } catch {
      setLinkError(t('offers.kfsUnsafe'));
    }
  }

  return (
    <ScrollScreen>
      <Heading>{t('offers.title')}</Heading>
      <Banner tone="info">{t('offers.disclaimer')}</Banner>
      <Card>
        <Label>{t('offers.how')}</Label>
        <Body>{data.rule.metric}</Body>
        <Body muted>{data.rule.summary}</Body>
        <Label>{t('offers.sortBy')}</Label>
        {sorts.map((s) => (
          <Choice
            key={s}
            label={t(`offers.sort.${s}` as MessageKey)}
            selected={(sort ?? data.rule.defaultSort[0]) === s}
            onPress={() => {
              setState({ kind: 'loading' });
              setSort(s === data.rule.defaultSort[0] ? undefined : s);
              setKey(newIdempotencyKey());
            }}
          />
        ))}
      </Card>

      {data.offers.length === 0 ? <Banner tone="info">{t('offers.none')}</Banner> : null}
      {data.offers.map((o) => (
        <Card key={o.offerId}>
          <Label>{o.lenderName}</Label>
          <Body muted>{o.productName}</Body>
          <Body muted>{t('offers.position', { n: o.rank })}</Body>
          <Body>{t('offers.amount', { amount: formatRupees(o.principalMinor) })}</Body>
          <Body>{t('offers.tenor', { days: o.tenureDays })}</Body>
          <Body>{t('offers.apr', { apr: formatAprBps(o.aprBps) })}</Body>
          <Body>{t('offers.monthly', { amount: formatRupees(o.monthlyRepaymentMinor) })}</Body>
          <Body>{t('offers.penal', { text: o.penalChargesSummary })}</Body>
          <Body muted>{t('offers.validUntil', { date: formatDate(o.validUntil, language) })}</Body>
          {o.revised ? <Body muted>{t('offers.revised', { n: o.revision })}</Body> : null}
          <Button title={t('offers.kfs')} onPress={() => void openKfs(o.kfsUrl)} />
          <Body muted>{t('offers.kfsNote')}</Body>
        </Card>
      ))}
      {linkError ? <Banner tone="danger">{linkError}</Banner> : null}

      {data.nonOffers.length > 0 ? (
        <>
          <Label>{t('offers.nonOffers')}</Label>
          {data.nonOffers.map((n) => (
            <Card key={n.applicationId}>
              <Body>{n.lenderName}</Body>
              <Body muted>{t(`offers.reason.${n.reason}` as MessageKey)}</Body>
            </Card>
          ))}
        </>
      ) : null}
    </ScrollScreen>
  );
}
