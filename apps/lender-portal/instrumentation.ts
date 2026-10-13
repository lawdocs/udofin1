export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Refuse to start with missing or unsafe configuration (including a privileged Supabase key).
    const { portalAuth } = await import('./lib/auth');
    portalAuth();
  }
}
