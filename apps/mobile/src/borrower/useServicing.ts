import { useMemo } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { createServicingClient, type ServicingClient } from './servicing';

/** The loan-screen client, built once for the signed-in API client. */
export function useServicing(): ServicingClient {
  const { api } = useAuth();
  return useMemo(() => createServicingClient(api), [api]);
}
