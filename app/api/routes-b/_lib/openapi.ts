import { z } from 'zod'

export interface RouteDefinition {
  method: string
  path: string
  summary: string
  description?: string
  requestSchema?: z.ZodTypeAny
  responseSchema?: z.ZodTypeAny
  tags?: string[]
}

const registry: RouteDefinition[] = []

// Records route metadata for OpenAPI doc generation.
// Currently a no-op registry kept so route modules (e.g. subscriptions)
// can import { registerRoute } at module scope.
export function registerRoute(route: RouteDefinition): void {
  registry.push(route)
}

export function getRegisteredRoutes(): RouteDefinition[] {
  return [...registry]
}
