import { type DocumentStore } from '@udofin/adapters';
import { borrowerRoutes } from '../modules/borrower/routes.js';
import { type BorrowerDeps } from '../modules/borrower/deps.js';
import { routingRoutes } from '../modules/routing/routes.js';
import { documentRoutes, type SigningMode } from '../modules/documents/routes.js';
import { adminRoutes } from '../modules/admin/routes.js';
import { meRoutes } from '../modules/me/routes.js';
import { panelRoutes } from '../modules/panel/routes.js';
import { productRoutes } from '../modules/products/routes.js';
import { onboardingRoutes } from '../modules/onboarding/routes.js';
import { type RouteDefinition } from './routes.js';

/** Route declarations (used by the app and by the OpenAPI generator). */
export function authenticatedRoutes(
  deps: { documents?: DocumentStore; borrower?: BorrowerDeps; signing?: SigningMode } = {},
): RouteDefinition[] {
  return [
    ...meRoutes,
    ...adminRoutes,
    ...onboardingRoutes(deps.documents),
    ...productRoutes,
    ...panelRoutes,
    ...borrowerRoutes(deps.borrower),
    ...routingRoutes,
    ...documentRoutes(deps.documents, deps.signing),
  ];
}
