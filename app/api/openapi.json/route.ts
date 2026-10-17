import { createHash } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'

export interface PublicRouteMetadata {
  path: string
  method: 'get' | 'post' | 'patch' | 'delete'
  operationId: string
  summary: string
  tags: string[]
  introducedIn: string
  deprecatedIn?: string
  requestSchemaRef?: string
  responseSchemaRef: string
  successStatus?: number
}

export const STABLE_OPENAPI_VERSIONS = ['2026-06-01', '2025-11-01', '2025-05-01'] as const
export type StableOpenApiVersion = (typeof STABLE_OPENAPI_VERSIONS)[number]

export const DEFAULT_OPENAPI_VERSION: StableOpenApiVersion = '2026-06-01'
export const OPENAPI_CACHE_CONTROL =
  'public, max-age=300, s-maxage=600, stale-while-revalidate=60'

const VERSION_FORMAT_REGEX = /^\d{4}-\d{2}-\d{2}$/

export const PUBLIC_ROUTE_CATALOG: readonly PublicRouteMetadata[] = Object.freeze([
  {
    path: '/api/invoices',
    method: 'get',
    operationId: 'listInvoices',
    summary: 'List invoices for the authenticated freelancer or business',
    tags: ['Invoices'],
    introducedIn: '2025-05-01',
    responseSchemaRef: '#/components/schemas/InvoiceListResponse',
  },
  {
    path: '/api/invoices',
    method: 'post',
    operationId: 'createInvoice',
    summary: 'Create a new payable invoice',
    tags: ['Invoices'],
    introducedIn: '2025-05-01',
    requestSchemaRef: '#/components/schemas/CreateInvoiceRequest',
    responseSchemaRef: '#/components/schemas/InvoiceResponse',
    successStatus: 201,
  },
  {
    path: '/api/user-webhooks',
    method: 'post',
    operationId: 'registerWebhook',
    summary: 'Register an outbound webhook endpoint',
    tags: ['Webhooks'],
    introducedIn: '2025-05-01',
    deprecatedIn: '2026-06-01',
    requestSchemaRef: '#/components/schemas/CreateWebhookRequest',
    responseSchemaRef: '#/components/schemas/WebhookResponse',
    successStatus: 201,
  },
  {
    path: '/api/webhook-deliveries/stats',
    method: 'get',
    operationId: 'getWebhookDeliveryStats',
    summary: 'Retrieve rolling delivery success rates per webhook',
    tags: ['Webhooks'],
    introducedIn: '2025-11-01',
    responseSchemaRef: '#/components/schemas/WebhookStatsResponse',
  },
  {
    path: '/api/developer-portal/sandbox-sessions',
    method: 'post',
    operationId: 'createSandboxSession',
    summary: 'Provision an isolated developer sandbox session',
    tags: ['DeveloperPortal'],
    introducedIn: '2026-06-01',
    requestSchemaRef: '#/components/schemas/CreateSandboxSessionRequest',
    responseSchemaRef: '#/components/schemas/SandboxSessionResponse',
    successStatus: 201,
  },
  {
    path: '/api/api-versions',
    method: 'get',
    operationId: 'listApiVersions',
    summary: 'List supported public API versions and sunset dates',
    tags: ['Meta'],
    introducedIn: '2026-06-01',
    responseSchemaRef: '#/components/schemas/ApiVersionsResponse',
  },
])

/**
 * Composes an OpenAPI 3.1.0 document for a specific stable API version.
 */
export function buildOpenApiDocument(version: StableOpenApiVersion) {
  const applicableRoutes = PUBLIC_ROUTE_CATALOG.filter(
    (route) => route.introducedIn <= version
  )

  const paths: Record<string, Record<string, unknown>> = {}

  for (const route of applicableRoutes) {
    if (!paths[route.path]) {
      paths[route.path] = {}
    }

    const isDeprecated = Boolean(route.deprecatedIn && route.deprecatedIn <= version)
    const status = String(route.successStatus ?? 200)

    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      summary: route.summary,
      tags: route.tags,
      ...(isDeprecated ? { deprecated: true } : {}),
      parameters: [
        {
          name: 'LancePay-Version',
          in: 'header',
          required: false,
          schema: { type: 'string', default: version },
          description: 'Pinned LancePay API version header',
        },
      ],
      ...(route.requestSchemaRef
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: { $ref: route.requestSchemaRef },
                },
              },
            },
          }
        : {}),
      responses: {
        [status]: {
          description: 'Successful response',
          content: {
            'application/json': {
              schema: { $ref: route.responseSchemaRef },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    }

    paths[route.path][route.method] = operation
  }

  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://spec.openapis.org/oas/3.1/dialect/base',
    info: {
      title: 'LancePay Public API',
      version,
      summary: `LancePay REST API Specification (${version})`,
      description:
        'Multi-chain freelancer invoicing, settlements, webhooks, and developer sandbox API.',
      contact: {
        name: 'LancePay Developer Support',
        url: 'https://docs.lancepay.io',
      },
    },
    servers: [
      {
        url: 'https://api.lancepay.io',
        description: 'Production API Gateway',
      },
      {
        url: 'https://sandbox.api.lancepay.io',
        description: 'Developer Sandbox Gateway',
      },
    ],
    security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
        },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string' },
            code: { type: 'string' },
          },
        },
        InvoiceResponse: {
          type: 'object',
          required: ['id', 'invoiceNumber', 'amount', 'currency', 'status'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            invoiceNumber: { type: 'string' },
            amount: { type: 'string' },
            currency: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'paid', 'overdue'] },
          },
        },
        InvoiceListResponse: {
          type: 'object',
          required: ['invoices'],
          properties: {
            invoices: {
              type: 'array',
              items: { $ref: '#/components/schemas/InvoiceResponse' },
            },
          },
        },
        CreateInvoiceRequest: {
          type: 'object',
          required: ['clientEmail', 'amount', 'currency'],
          properties: {
            clientEmail: { type: 'string', format: 'email' },
            amount: { type: 'string' },
            currency: { type: 'string', default: 'USD' },
          },
        },
        CreateWebhookRequest: {
          type: 'object',
          required: ['targetUrl', 'subscribedEvents'],
          properties: {
            targetUrl: { type: 'string', format: 'uri' },
            subscribedEvents: { type: 'array', items: { type: 'string' } },
          },
        },
        WebhookResponse: {
          type: 'object',
          required: ['id', 'targetUrl', 'status'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            targetUrl: { type: 'string', format: 'uri' },
            status: { type: 'string' },
          },
        },
        WebhookStatsResponse: {
          type: 'object',
          required: ['stats', 'flagged'],
          properties: {
            stats: { type: 'array', items: { type: 'object' } },
            flagged: { type: 'array', items: { type: 'string' } },
          },
        },
        CreateSandboxSessionRequest: {
          type: 'object',
          required: ['apiKeyId'],
          properties: {
            apiKeyId: { type: 'string' },
            ttlSeconds: { type: 'integer', minimum: 300, maximum: 86400 },
          },
        },
        SandboxSessionResponse: {
          type: 'object',
          required: ['session', 'data'],
          properties: {
            session: { type: 'object' },
            data: { type: 'object' },
          },
        },
        ApiVersionsResponse: {
          type: 'object',
          required: ['currentDefaultVersion', 'versions'],
          properties: {
            currentDefaultVersion: { type: 'string' },
            versions: { type: 'array', items: { type: 'object' } },
          },
        },
      },
    },
  }
}

export function computeSpecEtag(serializedSpec: string): string {
  const hash = createHash('sha256').update(serializedSpec, 'utf8').digest('hex').slice(0, 32)
  return `"sha256-${hash}"`
}

function matchesIfNoneMatch(ifNoneMatchHeader: string | null, etag: string): boolean {
  if (!ifNoneMatchHeader) return false
  const trimmed = ifNoneMatchHeader.trim()
  if (trimmed === '*') return true

  const normalize = (tag: string) => tag.trim().replace(/^W\//i, '')
  const target = normalize(etag)

  return trimmed
    .split(',')
    .map(normalize)
    .some((candidate) => candidate === target)
}

/**
 * GET /api/openapi.json
 * Serves the OpenAPI 3.1.0 specification for the requested stable API version
 * with deterministic ETag & Cache-Control headers and HTTP 304 conditional support.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const requestedVersion = searchParams.get('version')?.trim() ?? DEFAULT_OPENAPI_VERSION

    if (!VERSION_FORMAT_REGEX.test(requestedVersion)) {
      return NextResponse.json(
        {
          error: 'Invalid API version format. Expected YYYY-MM-DD (e.g. 2026-06-01).',
          code: 'INVALID_API_VERSION_FORMAT',
        },
        { status: 400 }
      )
    }

    if (!STABLE_OPENAPI_VERSIONS.includes(requestedVersion as StableOpenApiVersion)) {
      return NextResponse.json(
        {
          error: `Unsupported or sunset API version "${requestedVersion}"`,
          code: 'UNSUPPORTED_API_VERSION',
          supportedVersions: STABLE_OPENAPI_VERSIONS,
        },
        { status: 404 }
      )
    }

    const version = requestedVersion as StableOpenApiVersion
    const spec = buildOpenApiDocument(version)
    const serialized = JSON.stringify(spec)
    const etag = computeSpecEtag(serialized)

    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      ETag: etag,
      'Cache-Control': OPENAPI_CACHE_CONTROL,
      'X-OpenAPI-Version': version,
    }

    if (matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
      return new NextResponse(null, {
        status: 304,
        headers,
      })
    }

    return new NextResponse(serialized, {
      status: 200,
      headers,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/openapi.json error')
    return NextResponse.json(
      { error: 'Failed to generate OpenAPI specification' },
      { status: 500 }
    )
  }
}
