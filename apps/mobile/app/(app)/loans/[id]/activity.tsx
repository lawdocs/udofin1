import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { servicingErrorKey } from '../../../../src/borrower/servicing-errors';
import { LoanPage, SectionError, useText } from '../../../../src/borrower/servicing-ui';
import { type SvcActivityEntry, type SvcLoan } from '../../../../src/borrower/servicing-types';
import { activityRowModel, appendActivityPage } from '../../../../src/borrower/servicing-view';
import { useLoad } from '../../../../src/borrower/useLoad';
import { useServicing } from '../../../../src/borrower/useServicing';
import { useI18n } from '../../../../src/i18n/I18nProvider';
import { Banner, Body, Button, Card, Label } from '../../../../src/ui/kit';

/**
 * Lender receipts, the borrower's payment attempts and provider-reported adjustments, newest first, with the honest stage of
 * each. A payment attempt links to its own status screen. "Load more" passes the opaque cursor back unchanged.
 */
export default function ActivityScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useI18n();
  return (
    <LoanPage loanId={id ?? ''} title={t('loans.activity.title')}>
      {(loan) => <ActivityBody loan={loan} />}
    </LoanPage>
  );
}

interface Shown {
  items: SvcActivityEntry[];
  cursor: string | null;
}

function ActivityBody({ loan }: { loan: SvcLoan }) {
  const router = useRouter();
  const { t, language } = useI18n();
  const tx = useText();
  const servicing = useServicing();
  const first = useLoad(() => servicing.activity(loan.loanId), [servicing, loan.loanId]);
  const [more, setMore] = useState<Shown | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const lender = loan.lenderDisplayName;

  if (first.state.kind === 'loading') return <Body muted>{t('common.loading')}</Body>;
  if (first.state.kind === 'error') {
    return (
      <SectionError
        code={first.state.code}
        onRetry={() => {
          setMore(null);
          first.reload();
        }}
      />
    );
  }

  const shown: Shown = more ?? {
    items: first.state.data.items,
    cursor: first.state.data.nextCursor,
  };

  async function loadMore(cursor: string) {
    setLoadingMore(true);
    setMoreError(null);
    const result = await servicing.activity(loan.loanId, cursor);
    setLoadingMore(false);
    if (!result.ok) return setMoreError(result.code);
    setMore(appendActivityPage(shown.items, result.data));
  }

  return (
    <>
      <Body muted>{t('loans.activity.note', { lender })}</Body>
      {shown.items.length === 0 ? <Banner tone="info">{t('loans.activity.empty')}</Banner> : null}
      {shown.items.map((entry) => {
        const row = activityRowModel(entry, lender, language);
        const detail = row.detail;
        return (
          <Card key={row.id}>
            <Label>{tx(row.title)}</Label>
            {row.purpose ? <Body muted>{tx(row.purpose)}</Body> : null}
            <Body>{t('loans.activity.date', { date: row.date })}</Body>
            <Body>{tx(row.amount)}</Body>
            <Body>{tx(row.state)}</Body>
            {detail ? (
              <Button
                title={t('loans.activity.details')}
                secondary
                onPress={() => router.push(detail)}
              />
            ) : null}
          </Card>
        );
      })}
      {moreError ? <Banner tone="danger">{t(servicingErrorKey(moreError))}</Banner> : null}
      {shown.cursor ? (
        <Button
          title={t('loans.activity.more')}
          secondary
          busy={loadingMore}
          onPress={() => void loadMore(shown.cursor ?? '')}
        />
      ) : null}
    </>
  );
}
