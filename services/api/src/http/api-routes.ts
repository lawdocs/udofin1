import { type DocumentStore, type HandoffKeyring } from '@udofin/adapters';
import { borrowerRoutes } from '../modules/borrower/routes.js';
import { type BorrowerDeps } from '../modules/borrower/deps.js';
import { routingRoutes } from '../modules/routing/routes.js';
import { documentRoutes, type SigningMode } from '../modules/documents/routes.js';
import { adminRoutes } from '../modules/admin/routes.js';
import { meRoutes } from '../modules/me/routes.js';
import { panelRoutes } from '../modules/panel/routes.js';
import { productRoutes } from '../modules/products/routes.js';
import { onboardingRoutes } from '../modules/onboarding/routes.js';
import { servicingRoutes } from '../modules/servicing/routes.js';
import { paymentsRoutes } from '../modules/payments/routes.js';
import { lenderServicingRoutes } from '../modules/lender-servicing/routes.js';
import { lenderAccountsRoutes } from '../modules/lender-accounts/routes.js';
import { lenderPaymentsRoutes } from '../modules/lender-payments/routes.js';
import { lenderRemindersRoutes } from '../modules/lender-reminders/routes.js';
import { type RouteDefinition } from './routes.js';

/** Route declarations (used by the app and by the OpenAPI generator). */
export function authenticatedRoutes(
  deps: {
    documents?: DocumentStore;
    borrower?: BorrowerDeps;
    signing?: SigningMode;
    /** Phase 08a: opens the sealed provider hand-off links the worker stored. Without it the link routes answer 503. */
    handoff?: HandoffKeyring;
  } = {},
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
    ...servicingRoutes({ ...(deps.documents ? { documents: deps.documents } : {}) }),
    ...paymentsRoutes({ ...(deps.handoff ? { handoff: deps.handoff } : {}) }),
    ...lenderServicingRoutes({ ...(deps.documents ? { documents: deps.documents } : {}) }),
    ...lenderAccountsRoutes({}),
    ...lenderPaymentsRoutes({}),
    ...lenderRemindersRoutes({}),
  ];
}
