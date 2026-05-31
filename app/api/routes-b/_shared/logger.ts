import { logger as baseLogger } from '@/lib/logger'

export type RouteLogContext = {
  route: string
  [key: string]: unknown
}

/**
 * Returns a Pino child logger pre-bound with routes-b namespace and route context.
 * Request-id is automatically injected by the withRequestId middleware patch.
 * Never pass sensitive fields (tokens, account numbers) as context keys.
 */
export function createRouteLogger(context: RouteLogContext) {
  return baseLogger.child({ namespace: 'routes-b', ...context })
}

export { baseLogger as logger }
