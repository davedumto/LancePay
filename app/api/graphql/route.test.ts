import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    apiKey: {
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    invoice: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  },
}))

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { POST } from './route'

function makeGraphqlRequest(
  body: unknown,
  apiKey: string | null = 'lp_live_valid_key',
  extraHeaders: Record<string, string> = {},
): NextRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...extraHeaders,
  }
  if (apiKey) headers['x-api-key'] = apiKey
  return new NextRequest('http://localhost/api/graphql', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('POST /api/graphql', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.apiKey.findUnique.mockResolvedValue({
      id: 'ak-1',
      userId: 'user-1',
      isActive: true,
      tier: 'free',
      scopes: ['graphql:execute'],
    })
  })

  it('authenticates with a scoped API key and rejects introspection in production unless the key carries the schema scope', async () => {
    const unauth = await POST(
      makeGraphqlRequest({ query: '{ me { id } }' }, null),
    )
    expect(unauth.status).toBe(401)

    // In production without schema scope -> 403 INTROSPECTION_FORBIDDEN
    const introspectBlocked = await POST(
      makeGraphqlRequest(
        { query: '{ __schema { queryType { name } } }' },
        'lp_live_valid_key',
        { 'x-gateway-env': 'production' },
      ),
    )
    expect(introspectBlocked.status).toBe(403)
    const blockedBody = await introspectBlocked.json()
    expect(blockedBody.errors[0].extensions.code).toBe(
      'INTROSPECTION_FORBIDDEN',
    )

    // In production WITH schema:read scope -> 200 allowed
    mockPrisma.apiKey.findUnique.mockResolvedValueOnce({
      id: 'ak-schema',
      userId: 'user-1',
      isActive: true,
      tier: 'pro',
      scopes: ['graphql:execute', 'schema:read'],
    })
    const introspectAllowed = await POST(
      makeGraphqlRequest(
        { query: '{ __schema { queryType { name } } }' },
        'lp_live_schema_key',
        { 'x-gateway-env': 'production' },
      ),
    )
    expect(introspectAllowed.status).toBe(200)
    const allowedBody = await introspectAllowed.json()
    expect(allowedBody.data.__schema.queryType.name).toBe('Query')
  })

  it('computes query depth and weighted field complexity before execution and rejects queries exceeding the key tier budget', async () => {
    // 1. Depth 6 exceeds free tier maxDepth (4)
    const deepQuery = `{
      me {
        invoices {
          lineItems {
            invoice {
              user {
                id
              }
            }
          }
        }
      }
    }`
    const depthRes = await POST(makeGraphqlRequest({ query: deepQuery }))
    expect(depthRes.status).toBe(422)
    const depthBody = await depthRes.json()
    expect(depthBody.errors[0].extensions.code).toBe('QUERY_DEPTH_EXCEEDED')
    // Resolver was never called
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled()

    // 2. Weighted complexity exceeds free tier maxComplexity (50) while staying within depth 3
    const heavyComplexityQuery = `{
      invoices(limit: 100) {
        id
        amount
        lineItems {
          id
          description
        }
      }
    }`
    const complexityRes = await POST(
      makeGraphqlRequest({ query: heavyComplexityQuery }),
    )
    expect(complexityRes.status).toBe(422)
    const complexityBody = await complexityRes.json()
    expect(complexityBody.errors[0].extensions.code).toBe(
      'QUERY_COMPLEXITY_EXCEEDED',
    )
    expect(mockPrisma.invoice.findMany).not.toHaveBeenCalled()
  })

  it('formats resolver errors with stable codes while redacting internal stack traces and SQL details', async () => {
    const dbError = new Error(
      'Invalid `prisma.invoice.findMany()` invocation: SELECT * FROM "Invoice" connection pool timeout\n    at PrismaClient._executeRequest (/app/node_modules/@prisma/client/runtime/library.js:123:45)',
    )
    mockPrisma.invoice.findMany.mockRejectedValueOnce(dbError)

    const res = await POST(
      makeGraphqlRequest({
        query: '{ invoices { id amount status } }',
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.data).toBeNull()
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0].extensions.code).toBe('INTERNAL_RESOLVER_ERROR')
    // Internal Prisma/SQL details and stack trace frames must be completely redacted
    expect(JSON.stringify(body.errors[0])).not.toContain('SELECT * FROM')
    expect(JSON.stringify(body.errors[0])).not.toContain('node_modules')
    expect(body.errors[0].stack).toBeUndefined()
  })
})
