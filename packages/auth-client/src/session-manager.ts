import { AuthFailure, type GoTrueClient, type Session } from './gotrue.js';

/** Where a session is persisted. The mobile app supplies a Keychain/Keystore-backed implementation. */
export interface SessionStorage {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
  clear(): Promise<void>;
}

export type AuthState =
  | { status: 'loading' }
  | { status: 'signed_out'; reason: 'none' | 'expired' | 'revoked' | 'signed_out' }
  | { status: 'signed_in'; session: Session };

/** Refresh this many seconds before expiry. */
const REFRESH_MARGIN_SECONDS = 60;

function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.accessToken === 'string' &&
    typeof v.refreshToken === 'string' &&
    typeof v.expiresAt === 'number' &&
    typeof v.userId === 'string' &&
    (v.aal === 'aal1' || v.aal === 'aal2')
  );
}

/**
 * Holds the current session for a client app: loads it from secure storage, refreshes it before it
 * expires (one refresh at a time), and ends it safely when the server says it is no longer valid.
 * Refresh tokens rotate, so concurrent refreshes would invalidate each other: hence single-flight.
 */
export class SessionManager {
  private state: AuthState = { status: 'loading' };
  private listeners = new Set<(state: AuthState) => void>();
  private refreshing: Promise<Session | null> | undefined;
  /** Bumped whenever the session is ended, so a refresh that was already in flight cannot resurrect it. */
  private generation = 0;

  constructor(
    private readonly deps: {
      storage: SessionStorage;
      gotrue: GoTrueClient;
      /** Epoch seconds. */
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Math.floor(Date.now() / 1000);
  }

  getState(): AuthState {
    return this.state;
  }

  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(state: AuthState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  /** Call once at start-up. Restores a stored session, refreshing it if it is (nearly) expired. */
  async initialise(): Promise<AuthState> {
    const stored = await this.readStored();
    if (!stored) {
      this.set({ status: 'signed_out', reason: 'none' });
      return this.state;
    }
    if (stored.expiresAt - this.now() > REFRESH_MARGIN_SECONDS) {
      this.set({ status: 'signed_in', session: stored });
      return this.state;
    }
    this.state = { status: 'signed_in', session: stored };
    const refreshed = await this.refresh();
    if (!refreshed && this.state.status === 'signed_in') {
      // Temporary failure: keep the stored session so a later retry can succeed.
      this.set({ status: 'signed_in', session: stored });
    }
    return this.state;
  }

  private async readStored(): Promise<Session | null> {
    try {
      const raw = await this.deps.storage.load();
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return isSession(parsed) ? parsed : null;
    } catch {
      return null; // unreadable storage is treated as no session
    }
  }

  /** Accepts a new session (after sign-in or MFA) and persists it. */
  async setSession(session: Session): Promise<void> {
    // In-memory first: if the keystore write fails (full disk, locked keystore) the user stays signed in
    // for this run instead of losing a refresh token the server has already rotated.
    this.set({ status: 'signed_in', session });
    try {
      await this.deps.storage.save(JSON.stringify(session));
    } catch {
      // The next start-up will find no stored session and ask the user to sign in again.
    }
  }

  /**
   * Returns a usable access token, refreshing first when it is close to expiry. Returns null when
   * there is no valid session (state becomes signed_out with reason 'expired').
   */
  async getAccessToken(): Promise<string | null> {
    if (this.state.status !== 'signed_in') return null;
    if (this.state.session.expiresAt - this.now() > REFRESH_MARGIN_SECONDS)
      return this.state.session.accessToken;
    const refreshed = await this.refresh();
    return refreshed?.accessToken ?? null;
  }

  /** Call when the API answers 401 to a token we believed valid (revoked or rotated elsewhere). */
  async handleUnauthorised(): Promise<void> {
    if (this.state.status !== 'signed_in') return;
    const refreshed = await this.refresh(true);
    if (!refreshed && this.state.status === 'signed_in') {
      await this.endSession('revoked');
    }
  }

  private refresh(force = false): Promise<Session | null> {
    if (this.refreshing) return this.refreshing;
    if (this.state.status !== 'signed_in') return Promise.resolve(null);
    const current = this.state.session;
    if (!force && current.expiresAt - this.now() > REFRESH_MARGIN_SECONDS)
      return Promise.resolve(current);
    const generation = this.generation;
    this.refreshing = (async () => {
      try {
        const next = await this.deps.gotrue.refresh(current.refreshToken);
        if (generation !== this.generation) return null; // signed out while refreshing: discard the new tokens
        await this.setSession(next);
        return next;
      } catch (error) {
        if (
          error instanceof AuthFailure &&
          error.code === 'invalid_session' &&
          generation === this.generation
        ) {
          await this.endSession('expired'); // the server rejected the refresh token: sign in again
        }
        return null; // network trouble or rate limit: keep the session, try later
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  private async endSession(reason: 'expired' | 'revoked' | 'signed_out'): Promise<void> {
    this.generation += 1;
    try {
      await this.deps.storage.clear();
    } finally {
      this.set({ status: 'signed_out', reason });
    }
  }

  /** User-initiated sign-out. Local state is cleared even if the server cannot be reached. */
  async signOut(): Promise<void> {
    const token = this.state.status === 'signed_in' ? this.state.session.accessToken : undefined;
    await this.endSession('signed_out');
    if (token) {
      try {
        await this.deps.gotrue.signOut(token);
      } catch {
        // Best effort: the local session is already gone and the token expires on its own.
      }
    }
  }
}
