import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ApiError } from '../http/api-error.js';

/**
 * Per-principal rate limits for authenticated routes, IN ADDITION to the per-address limits.
 *
 * Why separate: the address limiter runs before authentication, so it can only key on the address.
 * Behind carrier NAT many borrowers share an address, and an attacker can rotate addresses against one
 * account. The key here is the VERIFIED user id (the token's `sub`, after signature, expiry and session
 * checks), falling back to the address if no principal was recorded. It uses the same limiter the
 * address limits use (`@fastify/rate-limit`, driven by hand after verification), so counting, headers
 * and the in-memory store behave identically. The store is per process, like the address limiter;
 * a shared store is a deployment decision (docs/api/README.md).
 */
export interface RouteLimit {
  max: number;
  timeWindow: string;
}

export interface PrincipalLimits {
  /** Records the verified principal for this request, then enforces the ceiling and the route's own limit. Throws ApiError 429. */
  enforce(
    request: FastifyRequest,
    principalId: string,
    route: { id: string; limit?: RouteLimit | false | undefined },
  ): Promise<void>;
}

const principals = new WeakMap<FastifyRequest, string>();

type Check = (request: FastifyRequest) => Promise<{
  isAllowed: boolean;
  isExceeded?: boolean;
  ttlInSeconds?: number;
}>;

export function createPrincipalLimits(
  app: FastifyInstance,
  ceilingPerMinute: number,
): PrincipalLimits {
  const keyOf = (request: FastifyRequest): string => principals.get(request) ?? `ip:${request.ip}`;
  const ceiling: Check = app.createRateLimit({
    max: ceilingPerMinute,
    timeWindow: '1 minute',
    keyGenerator: (request: FastifyRequest) => `principal:${keyOf(request)}`,
  });
  const perRoute = new Map<string, Check>();

  async function apply(check: Check, request: FastifyRequest): Promise<void> {
    const result = await check(request);
    if (!result.isAllowed && result.isExceeded) {
      throw new ApiError(429, 'rate_limited', 'Too Many Requests', undefined, {
        'retry-after': String(Math.max(1, result.ttlInSeconds ?? 60)),
      });
    }
  }

  return {
    async enforce(request, principalId, route) {
      principals.set(request, principalId);
      await apply(ceiling, request);
      if (!route.limit) return;
      let check = perRoute.get(route.id);
      if (!check) {
        check = app.createRateLimit({
          max: route.limit.max,
          timeWindow: route.limit.timeWindow,
          keyGenerator: (r: FastifyRequest) => `route:${route.id}:${keyOf(r)}`,
        });
        perRoute.set(route.id, check);
      }
      await apply(check, request);
    },
  };
}
