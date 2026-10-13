import { createChangeRequestApplier, type ChangeRequestApplier } from './change-requests.js';
import { createSystemPool } from './pool.js';

/** What the rest of the API may use from the system role: narrow capabilities, never the pool. */
export interface SystemServices {
  changeRequestApplier: ChangeRequestApplier;
  close(): Promise<void>;
}

export function createSystemServices(connectionString: string): SystemServices {
  const pool = createSystemPool(connectionString);
  return { changeRequestApplier: createChangeRequestApplier(pool), close: () => pool.end() };
}
