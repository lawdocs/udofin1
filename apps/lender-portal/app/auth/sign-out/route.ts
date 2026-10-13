import { portalAuth } from '@/lib/auth';

// Browser-facing auth endpoint (same origin only). Tokens are set as HttpOnly cookies by the handler.
export async function POST(request: Request) {
  return portalAuth().handlers.signOut(request);
}
