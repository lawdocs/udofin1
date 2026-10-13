import { adminRoutes } from '../modules/admin/routes.js';
import { meRoutes } from '../modules/me/routes.js';
import { type RouteDefinition } from './routes.js';

/** Route declarations that need no runtime dependencies (used by the OpenAPI generator). */
export const authenticatedRoutes: RouteDefinition[] = [...meRoutes, ...adminRoutes];
