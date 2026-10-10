import { connection } from 'next/server';

export default async function HomePage() {
  // Render per request so every response carries a fresh CSP nonce.
  await connection();
  return (
    <main className="shell">
      <h1>Udofin Operations</h1>
      <p className="muted">Foundation build — no portal features are implemented yet.</p>
    </main>
  );
}
