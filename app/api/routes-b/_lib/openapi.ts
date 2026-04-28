/**
 * OpenAPI 3.1 registry and generator for routes-b endpoints.
 * 
 * Each route can register its documentation, which is then assembled
 * into a complete OpenAPI document available at GET /_openapi.
 */

import { z } from 'zod'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface RouteRegistration {
  method: HttpMethod
  path: string
  summary: string
  description?: string
  requestSchema?: z.ZodTypeAny
  responseSchema?: z.ZodTypeAny
  tags?: string[]
  deprecated?: boolean
}

// Internal registry
const registry: RouteRegistration[] = []

/**
 * Register a route for OpenAPI documentation.
 */
export function registerRoute(registration: RouteRegistration): void {
  registry.push(registration)
}

/**
 * Convert a Zod schema to OpenAPI schema object.
 */
function zodToOpenAPI(schema: z.ZodTypeAny): any {
  // Basic implementation - can be extended as needed
  if (schema instanceof z.ZodString) {
    return { type: 'string' }
  }
  if (schema instanceof z.ZodNumber) {
    return { type: 'number' }
  }
  if (schema instanceof z.ZodBoolean) {
    return { type: 'boolean' }
  }
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: zodToOpenAPI(schema.element) }
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape || {}
    const properties: Record<string, any> = {}
    const required: string[] = []
    
    Object.entries(shape).forEach(([key, value]) => {
      properties[key] = zodToOpenAPI(value as z.ZodTypeAny)
      // Check if field is optional
      if (!(value instanceof z.ZodOptional || 
            value instanceof z.ZodNullable || 
            value instanceof z.ZodDefault)) {
        required.push(key)
      }
    })
    
    return {
      type: 'object',
      properties,
      ...(required.length > 0 && { required })
    }
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return zodToOpenAPI(schema._def.innerType)
  }
  if (schema instanceof z.ZodDefault) {
    return zodToOpenAPI(schema._def.innerType)
  }
  
  // Fallback for unknown types
  return { type: 'object' }
}

/**
 * Generate the complete OpenAPI 3.1 document.
 */
export function generateOpenAPIDocument(baseUrl: string = 'http://localhost:3000'): any {
  const paths: Record<string, any> = {}
  
  registry.forEach(route => {
    const pathKey = route.path.startsWith('/') ? route.path : `/${route.path}`
    
    if (!paths[pathKey]) {
      paths[pathKey] = {}
    }
    
    const operation: any = {
      summary: route.summary,
      ...(route.description && { description: route.description }),
      ...(route.tags && { tags: route.tags }),
      ...(route.deprecated && { deprecated: true }),
      responses: {
        '200': {
          description: 'Success',
          ...(route.responseSchema && {
            content: {
              'application/json': {
                schema: zodToOpenAPI(route.responseSchema)
              }
            }
          })
        },
        '400': { description: 'Bad Request' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden' },
        '404': { description: 'Not Found' },
        '500': { description: 'Internal Server Error' }
      }
    }
    
    if (route.requestSchema) {
      operation.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: zodToOpenAPI(route.requestSchema)
          }
        }
      }
    }
    
    paths[pathKey][route.method.toLowerCase()] = operation
  })
  
  return {
    openapi: '3.1.0',
    info: {
      title: 'LancePay Routes-B API',
      description: 'API for LancePay routes-b endpoints',
      version: '1.0.0'
    },
    servers: [
      { url: baseUrl, description: 'Development server' }
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      }
    },
    security: [{ bearerAuth: [] }]
  }
}

/**
 * Get all registered routes (for testing/debugging).
 */
export function getRegisteredRoutes(): RouteRegistration[] {
  return [...registry]
}

/**
 * Clear the registry (for testing).
 */
export function clearRegistry(): void {
  registry.length = 0
}