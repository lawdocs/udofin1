import { z } from 'zod';
import { publicRoute, type RouteDefinition } from '../../http/routes.js';
import { type ReadinessCheck } from '../../app.js';

const READINESS_TIMEOUT_MS = 2_000;

const LiveResponse = z.object({ status: z.literal('ok') });
const ReadyResponse = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.record(z.string(), z.enum(['ok', 'failing'])),
});

export function healthRoutes(
  checks: readonly ReadinessCheck[],
  onCheckFailed: (name: string, error: unknown) => void,
): RouteDefinition[] {
  return [
    publicRoute({
      method: 'get',
      path: '/health/live',
      operationId: 'getLiveness',
      summary: 'Liveness probe',
      description:
        'The process is up. Never touches dependencies, so restarts are not triggered by them.',
      tags: ['Operations'],
      auth: 'none',
      rateLimit: false,
      responses: { 200: LiveResponse },
      handler: () => Promise.resolve({ status: 200, body: { status: 'ok' } }),
    }),
    publicRoute({
      method: 'get',
      path: '/health/ready',
      operationId: 'getReadiness',
      summary: 'Readiness probe',
      description:
        'Every dependency answers within two seconds. Reports dependency names only, never error text.',
      tags: ['Operations'],
      auth: 'none',
      rateLimit: { max: 30, timeWindow: '1 minute' },
      responses: { 200: ReadyResponse, 503: ReadyResponse },
      handler: async () => {
        const results = await Promise.all(
          checks.map(async (dependency) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), READINESS_TIMEOUT_MS);
            try {
              await Promise.race([
                dependency.check(controller.signal),
                new Promise<never>((_, reject) => {
                  controller.signal.addEventListener('abort', () => reject(new Error('timeout')));
                }),
              ]);
              return { name: dependency.name, ok: true };
            } catch (error) {
              onCheckFailed(dependency.name, error);
              return { name: dependency.name, ok: false };
            } finally {
              clearTimeout(timer);
            }
          }),
        );
        const ready = results.every((result) => result.ok);
        return {
          status: ready ? 200 : 503,
          body: {
            status: ready ? 'ready' : 'not_ready',
            checks: Object.fromEntries(results.map((r) => [r.name, r.ok ? 'ok' : 'failing'])),
          },
        };
      },
    }),
  ];
}
