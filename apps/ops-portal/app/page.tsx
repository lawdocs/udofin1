import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { requireSession } from '@/components/session-gate';

export default async function HomePage() {
  await connection(); // render per request so every response carries a fresh CSP nonce
  const session = await requireSession();
  if ('blocked' in session) return session.blocked;
  const { me } = session;
  return (
    <PageFrame me={me} current="/">
      <h1>Udofin Operations</h1>
      <p className="muted">
        Foundation build: sign-in, roles and two-person approval of administrative changes. No
        lending features yet.
      </p>
      <section aria-labelledby="who">
        <h2 id="who">Your access</h2>
        {me.memberships.map((m) => (
          <article key={m.membershipId} className="card">
            <h3>{m.organizationName}</h3>
            <p className="muted">Organisation type: {m.organizationKind}</p>
            <ul>
              {m.permissions.map((p) => (
                <li key={p}>
                  <code>{p}</code>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>
    </PageFrame>
  );
}
