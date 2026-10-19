import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_VERSION } from '../src/app.js';
import { authenticatedRoutes } from '../src/http/api-routes.js';
import { buildOpenApi } from '../src/http/openapi.js';
import { healthRoutes } from '../src/modules/health/routes.js';

/** Writes docs/api/openapi.json. Run `pnpm --filter @udofin/api openapi` after changing a route. */
const routes = [...healthRoutes([], () => undefined), ...authenticatedRoutes()];
const target = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'api',
  'openapi.json',
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(buildOpenApi(routes, API_VERSION), null, 2)}\n`);
process.stdout.write(`wrote ${target}\n`);
