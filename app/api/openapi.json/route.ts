import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { logger } from '@/lib/logger'

export interface RouteMetadata {
  path: string
  method: 'get' | 'post' | 'put' | 'patch' | 'delete'
  summary: string
  description?: string
  tags: string[]
  parameters?: Array<{
    name: string
    in: 'query' | 'path' | 'header'
    required?: boolean
    schema: Record<string, unknown>
    description?: string
  }>
  requestBody?: {
    required?: boolean
    content: Record<string, { schema: Record<string, unknown> }>
  }
  responses: Record<
    string,
    {
      description: string
      content?: Record<string, { schema: Record<string, unknown> }>
      headers?: Record<string, { description: string; schema: Record<string, unknown> }>
    }
  >
  apiVersion?: string
}

/**
 * Standard 429 response shared by every rate-limited public endpoint.
 * X-RateLimit-Reset is epoch seconds; Retry-After is seconds until reset.
 */
const RATE_LIMIT_429_RESPONSE = {
  description: 'Rate limit exceeded',
  headers: {
    'X-RateLimit-Limit': {
      description: 'Maximum requests allowed in the current window',
      schema: { type: 'integer' },
    },
    'X-RateLimit-Remaining': {
      description: 'Requests remaining in the current window',
      schema: { type: 'integer' },
    },
    'X-RateLimit-Reset': {
      description: 'Epoch seconds at which the current window resets',
      schema: { type: 'integer' },
    },
    'X-RateLimit-Policy': {
      description: 'Identifier of the rate-limit policy that was applied',
      schema: { type: 'string' },
    },
    'Retry-After': {
      description: 'Seconds to wait before retrying',
      schema: { type: 'integer' },
    },
  },
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          limit: { type: 'integer' },
          remaining: { type: 'integer' },
          resetAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
}

export const CANONICAL_PUBLIC_ROUTES: RouteMetadata[] = [
  {
    path: '/api/invoices',
    method: 'get',
    summary: 'List user invoices',
    tags: ['Invoices'],
    apiVersion: '2026-10-01',
    parameters: [
      { name: 'status', in: 'query', schema: { type: 'string' }, description: 'Filter by invoice status' },
      { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 }, description: 'Page limit' },
    ],
    responses: {
      '200': { description: 'Invoices list retrieved successfully' },
      '401': { description: 'Unauthorized' },
    },
  },
  {
    path: '/api/invoices',
    method: 'post',
    summary: 'Create a new invoice',
    tags: ['Invoices'],
    apiVersion: '2026-10-01',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['clientEmail', 'amount', 'currency'],
            properties: {
              clientEmail: { type: 'string', format: 'email' },
              amount: { type: 'number' },
              currency: { type: 'string', default: 'USDC' },
            },
          },
        },
      },
    },
    responses: {
      '201': { description: 'Invoice created' },
      '400': { description: 'Invalid input' },
    },
  },
  {
    path: '/api/withdrawals',
    method: 'post',
    summary: 'Initiate a fiat/crypto offramp withdrawal',
    tags: ['Withdrawals'],
    apiVersion: '2026-10-01',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['amount', 'anchorId'],
            properties: {
              amount: { type: 'number' },
              anchorId: { type: 'string' },
            },
          },
        },
      },
    },
    responses: {
      '200': { description: 'Withdrawal initiated' },
      '400': { description: 'Invalid withdrawal params' },
    },
  },
  {
    path: '/api/stellar/trustlines/usdc/bootstrap',
    method: 'post',
    summary: 'Bootstrap USDC trustline with sponsored reserve',
    tags: ['Stellar'],
    apiVersion: '2026-10-18',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['walletAddress'],
            properties: {
              walletAddress: { type: 'string' },
            },
          },
        },
      },
    },
    responses: {
      '201': { description: 'Trustline bootstrapped' },
      '409': { description: 'Trustline already active' },
    },
  },
  {
    path: '/api/graphql/persisted-queries',
    method: 'post',
    summary: 'Register a hash-based persisted GraphQL query',
    tags: ['GraphQL'],
    apiVersion: '2026-10-18',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['appId', 'query'],
            properties: {
              appId: { type: 'string' },
              query: { type: 'string' },
              hash: { type: 'string' },
            },
          },
        },
      },
    },
    responses: {
      '201': { description: 'Query registered' },
      '400': { description: 'Hash mismatch or depth exceeded' },
    },
  },
]

export function buildOpenApiSpec(version = '2026-10-18'): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}

  // Filter routes if prior stable version requested
  const filteredRoutes = CANONICAL_PUBLIC_ROUTES.filter((r) => {
    if (!r.apiVersion) return true
    return r.apiVersion <= version || version === 'latest'
  })

  for (const route of filteredRoutes) {
    if (!paths[route.path]) {
      paths[route.path] = {}
    }
    paths[route.path][route.method] = {
      summary: route.summary,
      description: route.description,
      tags: route.tags,
      parameters: route.parameters,
      requestBody: route.requestBody,
      responses: { '429': RATE_LIMIT_429_RESPONSE, ...route.responses },
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'LancePay Public API',
      version,
      description:
        'Canonical OpenAPI 3.1 specification for LancePay developer platform, SDKs, and payment services. ' +
        'Rate-limited endpoints return 429 with X-RateLimit-Limit, X-RateLimit-Remaining, ' +
        'X-RateLimit-Reset (epoch seconds), X-RateLimit-Policy and Retry-After headers; ' +
        'the same headers are also sent on successful responses.',
      contact: {
        name: 'LancePay Support',
        url: 'https://lancepay.com/support',
      },
    },
    servers: [
      {
        url: 'https://api.lancepay.com',
        description: 'Production Gateway',
      },
      {
        url: 'https://sandbox.api.lancepay.com',
        description: 'Developer Sandbox',
      },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
        },
      },
    },
  }
}

export function computeSpecHash(spec: Record<string, unknown>): string {
  const json = JSON.stringify(spec)
  return crypto.createHash('sha256').update(json, 'utf8').digest('hex')
}

/**
 * GET /api/openapi.json
 *
 * Serves canonical OpenAPI 3.1 specification derived dynamically from route metadata.
 * - Composes spec from handler route metadata to prevent drift.
 * - Supports ?version= query parameter to request prior API specs.
 * - Sets cache headers and ETag tied to build-time spec hash.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const versionParam = searchParams.get('version')?.trim() || '2026-10-18'

    const spec = buildOpenApiSpec(versionParam)
    const specHash = computeSpecHash(spec)
    const etag = `"${specHash}"`

    // Conditional check for 304 Not Modified
    const clientEtag = request.headers.get('if-none-match')?.trim()
    if (clientEtag && (clientEtag === etag || clientEtag === specHash)) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Cache-Control': 'public, max-age=86400, stale-while-revalidate=3600',
        },
      })
    }

    return NextResponse.json(spec, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ETag: etag,
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=3600',
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/openapi.json error')
    return NextResponse.json({ error: 'Failed to generate OpenAPI specification' }, { status: 500 })
  }
}
