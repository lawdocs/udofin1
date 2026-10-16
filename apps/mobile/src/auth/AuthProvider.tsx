import {
  createApiClient,
  createGoTrueClient,
  SessionManager,
  type ApiClient,
  type AuthState,
  type GoTrueClient,
} from '@udofin/auth-client';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { ConfigError, loadMobileConfig, type MobileConfig } from '../config/env';
import { createSecureSessionStorage } from './secure-session-storage';
import { OtpFlow } from './otp-flow';

// Keychain/Keystore item is readable only while the device is unlocked and never migrates to another device.
const keystore = {
  getItemAsync: (key: string) => SecureStore.getItemAsync(key),
  setItemAsync: (key: string, value: string) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  deleteItemAsync: (key: string) => SecureStore.deleteItemAsync(key),
};

interface AuthContextValue {
  state: AuthState;
  api: ApiClient;
  otp: OtpFlow;
  signOut: () => Promise<void>;
  config: MobileConfig;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

interface Services {
  config: MobileConfig;
  manager: SessionManager;
  gotrue: GoTrueClient;
  api: ApiClient;
  otp: OtpFlow;
}

function createServices(): Services | ConfigError {
  let config: MobileConfig;
  try {
    const extra = Constants.expoConfig?.extra as { appEnv?: unknown } | undefined;
    const appEnv = typeof extra?.appEnv === 'string' ? extra.appEnv : 'local';
    config = loadMobileConfig(appEnv);
  } catch (error) {
    return error instanceof ConfigError ? error : new ConfigError('invalid app configuration');
  }
  const gotrue = createGoTrueClient({
    baseUrl: config.supabaseUrl,
    publishableKey: config.supabasePublishableKey,
  });
  const manager = new SessionManager({ storage: createSecureSessionStorage(keystore), gotrue });
  const api = createApiClient({
    baseUrl: config.apiBaseUrl,
    getAccessToken: () => manager.getAccessToken(),
    onUnauthorised: async () => {
      await manager.handleUnauthorised();
      return manager.getState().status === 'signed_in';
    },
  });
  return { config, manager, gotrue, api, otp: new OtpFlow({ gotrue, session: manager }) };
}

/**
 * Owns the borrower session for the whole app: restores it from the keystore at start, keeps it
 * fresh (also when the app returns to the foreground) and exposes sign-out. If the build is
 * misconfigured the app shows a clear message instead of crashing.
 */
export function AuthProvider({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: (error: ConfigError) => ReactNode;
}) {
  const services = useMemo(() => createServices(), []);
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    if (services instanceof ConfigError) return;
    const unsubscribe = services.manager.subscribe(setState);
    void services.manager.initialise();
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') void services.manager.getAccessToken(); // refreshes when near expiry
    });
    return () => {
      unsubscribe();
      appState.remove();
    };
  }, [services]);

  if (services instanceof ConfigError) return <>{fallback(services)}</>;
  const value: AuthContextValue = {
    state,
    api: services.api,
    otp: services.otp,
    signOut: () => services.manager.signOut(),
    config: services.config,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
