import { logger as baseLogger } from '@/lib/logger'

export type RouteLogContext = {
  route: string
  [key: string]: unknown
}

/**
 * Returns a Pino child logger pre-bound with routes-d namespace and route context.
 * Never pass sensitive fields (tokens, account numbers) as context keys.
 */
export function createRouteLogger(context: RouteLogContext) {
  return baseLogger.child({ namespace: 'routes-d', ...context })
}

export { baseLogger as logger }