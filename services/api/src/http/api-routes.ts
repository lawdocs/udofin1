import { type DocumentStore } from '@udofin/adapters';
import { borrowerRoutes } from '../modules/borrower/routes.js';
import { type BorrowerDeps } from '../modules/borrower/deps.js';
import { adminRoutes } from '../modules/admin/routes.js';
import { meRoutes } from '../modules/me/routes.js';
import { panelRoutes } from '../modules/panel/routes.js';
import { productRoutes } from '../modules/products/routes.js';
import { onboardingRoutes } from '../modules/onboarding/routes.js';
import { type RouteDefinition } from './routes.js';

/** Route declarations (used by the app and by the OpenAPI generator). */
export function authenticatedRoutes(
  deps: { documents?: DocumentStore; borrower?: BorrowerDeps } = {},
): RouteDefinition[] {
  return [
    ...meRoutes,
    ...adminRoutes,
    ...onboardingRoutes(deps.documents),
    ...productRoutes,
    ...panelRoutes,
    ...borrowerRoutes(deps.borrower),
  ];
}
