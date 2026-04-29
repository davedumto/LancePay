import { describe, it, expect, beforeEach } from 'vitest'
import { 
  registerRoute, 
  generateOpenAPIDocument, 
  getRegisteredRoutes, 
  clearRegistry 
} from '../_lib/openapi'
import { z } from 'zod'

describe('OpenAPI registry', () => {
  beforeEach(() => {
    clearRegistry()
  })

  it('registers routes', () => {
    registerRoute({
      method: 'GET',
      path: '/test',
      summary: 'Test endpoint',
      responseSchema: z.object({ message: z.string() })
    })

    const routes = getRegisteredRoutes()
    expect(routes).toHaveLength(1)
    expect(routes[0].path).toBe('/test')
    expect(routes[0].summary).toBe('Test endpoint')
  })

  it('generates valid OpenAPI document', () => {
    registerRoute({
      method: 'GET',
      path: '/stats',
      summary: 'Get stats',
      responseSchema: z.object({ count: z.number() })
    })

    registerRoute({
      method: 'POST',
      path: '/invoices',
      summary: 'Create invoice',
      requestSchema: z.object({ amount: z.number() }),
      responseSchema: z.object({ id: z.string() })
    })

    const doc = generateOpenAPIDocument('http://localhost:3000')
    
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info.title).toBe('LancePay Routes-B API')
    expect(doc.paths['/stats']).toBeDefined()
    expect(doc.paths['/invoices']).toBeDefined()
    expect(doc.paths['/stats'].get.summary).toBe('Get stats')
    expect(doc.paths['/invoices'].post.summary).toBe('Create invoice')
  })

  it('includes security scheme', () => {
    const doc = generateOpenAPIDocument()
    expect(doc.components.securitySchemes.bearerAuth).toEqual({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT'
    })
    expect(doc.security).toEqual([{ bearerAuth: [] }])
  })

  it('handles missing fields gracefully', () => {
    registerRoute({
      method: 'GET',
      path: '/simple',
      summary: 'Simple endpoint'
      // No schemas, tags, or description
    })

    const doc = generateOpenAPIDocument()
    expect(doc.paths['/simple'].get.responses).toBeDefined()
    expect(doc.paths['/simple'].get.tags).toBeUndefined()
  })

  it('converts Zod schemas to OpenAPI', () => {
    const requestSchema = z.object({
      name: z.string(),
      age: z.number().optional(),
      tags: z.array(z.string())
    })

    const responseSchema = z.object({
      id: z.string(),
      createdAt: z.string()
    })

    registerRoute({
      method: 'POST',
      path: '/users',
      summary: 'Create user',
      requestSchema,
      responseSchema
    })

    const doc = generateOpenAPIDocument()
    const operation = doc.paths['/users'].post
    
    expect(operation.requestBody.content['application/json'].schema).toBeDefined()
    expect(operation.responses['200'].content['application/json'].schema).toBeDefined()
  })

  it('handles different HTTP methods on same path', () => {
    registerRoute({
      method: 'GET',
      path: '/items',
      summary: 'Get items'
    })

    registerRoute({
      method: 'POST',
      path: '/items',
      summary: 'Create item'
    })

    const doc = generateOpenAPIDocument()
    expect(doc.paths['/items'].get).toBeDefined()
    expect(doc.paths['/items'].post).toBeDefined()
  })
})