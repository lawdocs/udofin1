import { LoadingState } from '@udofin/portal-kit';

export default function Loading() {
  return (
    <main className="shell">
      <LoadingState label="Loading mandates…" />
    </main>
  );
}
