import { type DocumentStore } from '@udofin/adapters';
import { adminRoutes } from '../modules/admin/routes.js';
import { meRoutes } from '../modules/me/routes.js';
import { onboardingRoutes } from '../modules/onboarding/routes.js';
import { type RouteDefinition } from './routes.js';

/** Route declarations (used by the app and by the OpenAPI generator). */
export function authenticatedRoutes(deps: { documents?: DocumentStore } = {}): RouteDefinition[] {
  return [...meRoutes, ...adminRoutes, ...onboardingRoutes(deps.documents)];
}
