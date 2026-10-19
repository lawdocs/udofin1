import { connection } from 'next/server';
import { LoginClient } from './login-client';

export default async function LoginPage() {
  await connection(); // per-request render: carries the CSP nonce
  return (
    <main className="shell auth-card">
      <LoginClient portalName="Udofin Lender Portal" />
    </main>
  );
}
