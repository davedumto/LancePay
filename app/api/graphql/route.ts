import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

export type GatewayTier = 'free' | 'pro' | 'enterprise'

export const GATEWAY_TIER_BUDGETS: Record<
  GatewayTier,
  { maxDepth: number; maxComplexity: number }
> = {
  free: { maxDepth: 4, maxComplexity: 50 },
  pro: { maxDepth: 8, maxComplexity: 200 },
  enterprise: { maxDepth: 12, maxComplexity: 1000 },
}

export const WEIGHTED_COLLECTION_FIELDS: Record<string, number> = {
  invoices: 15,
  transactions: 15,
  lineItems: 10,
  creditNotes: 12,
  webhooks: 10,
  deliveries: 15,
}

const SCHEMA_SCOPES = new Set([
  'schema',
  'schema:read',
  'graphql:schema',
  'graphql:introspect',
])

export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey.trim()).digest('hex')
}

export function stripGraphqlComments(query: string): string {
  return query.replace(/#[^\n\r]*/g, ' ').trim()
}

export function isIntrospectionQuery(query: string): boolean {
  const cleaned = stripGraphqlComments(query)
  return /\b__(?:schema|type)\b/.test(cleaned)
}

/**
 * Computes selection nesting depth and weighted field complexity from a GraphQL document
 * prior to resolver execution.
 */
export function analyzeQueryDepthAndComplexity(query: string): {
  depth: number
  complexity: number
  rootFields: string[]
} {
  const cleaned = stripGraphqlComments(query)
  // Strip argument parentheticals while keeping any limit argument value for weighting
  const limitMatches = [...cleaned.matchAll(/\blimit\s*:\s*(\d+)/g)]
  const maxExplicitLimit = limitMatches.reduce(
    (max, m) => Math.max(max, parseInt(m[1], 10) || 0),
    0,
  )

  const withoutArgs = cleaned.replace(/\([^)]*\)/g, '')
  let currentBraceDepth = 0
  let maxBraceDepth = 0

  for (const ch of withoutArgs) {
    if (ch === '{') {
      currentBraceDepth += 1
      if (currentBraceDepth > maxBraceDepth) {
        maxBraceDepth = currentBraceDepth
      }
    } else if (ch === '}') {
      currentBraceDepth = Math.max(0, currentBraceDepth - 1)
    }
  }

  // Extract field identifiers inside selection sets
  const bodyWithoutHeader = withoutArgs.replace(
    /^\s*(?:query|mutation|subscription)\b[^{]*\{/,
    '{',
  )
  const tokens =
    bodyWithoutHeader
      .replace(/[{}]/g, ' ')
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(
        (t) =>
          Boolean(t) &&
          /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t) &&
          t !== 'query' &&
          t !== 'mutation' &&
          t !== 'fragment' &&
          t !== 'on',
      ) ?? []

  let complexity = 0
  for (const token of tokens) {
    const baseWeight = WEIGHTED_COLLECTION_FIELDS[token] ?? 1
    if (WEIGHTED_COLLECTION_FIELDS[token] && maxExplicitLimit > 0) {
      complexity += baseWeight + Math.min(maxExplicitLimit, 200)
    } else {
      complexity += baseWeight
    }
  }

  // Extract top-level root fields (depth 1 inside outer selection set)
  const rootFields: string[] = []
  let depth = 0
  let buffer = ''
  for (const ch of withoutArgs) {
    if (ch === '{') {
      if (depth === 1 && buffer.trim()) {
        const parts = buffer
          .trim()
          .split(/[\s,]+/)
          .filter(Boolean)
        const last = parts[parts.length - 1]
        if (last && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(last)) {
          rootFields.push(last)
        }
        buffer = ''
      }
      depth += 1
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1)
      buffer = ''
    } else if (depth === 1) {
      buffer += ch
    }
  }

  return {
    depth: maxBraceDepth,
    complexity,
    rootFields,
  }
}

export function formatRedactedGraphqlError(
  err: unknown,
  path: string[] = [],
): {
  message: string
  path: string[]
  extensions: { code: string }
} {
  const rawMessage =
    err instanceof Error ? err.message : 'Unexpected resolver failure'
  const explicitCode =
    err &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code?: unknown }).code === 'string'
      ? ((err as { code: string }).code as string)
      : null

  // Redact internal stack traces, SQL/Prisma internals, and file paths
  const isInternalLeak =
    /prisma|postgres|SELECT\s|INSERT\s|connection\s+pool|ECONNREFUSED|at\s+\w+\s*\(/i.test(
      rawMessage,
    )

  const stableCode =
    explicitCode && /^[A-Z0-9_]+$/.test(explicitCode)
      ? explicitCode
      : isInternalLeak
        ? 'INTERNAL_RESOLVER_ERROR'
        : 'RESOLVER_EXECUTION_ERROR'

  const safeMessage = isInternalLeak
    ? 'An internal error occurred while resolving the requested GraphQL field'
    : rawMessage.split('\n')[0].trim()

  return {
    message: safeMessage,
    path,
    extensions: {
      code: stableCode,
    },
  }
}

function extractRawApiKey(req: NextRequest): string | null {
  const headerKey = req.headers.get('x-api-key')?.trim()
  if (headerKey) return headerKey

  const authHeader = req.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7).trim() || null
  }
  return null
}

/**
 * POST /api/graphql
 * Public GraphQL query gateway with per-key depth and complexity limits:
 * - Authenticates requests with a scoped API key and rejects introspection in production
 *   unless the key carries the schema scope (`schema` / `schema:read` / `graphql:introspect`).
 * - Computes query depth and weighted field complexity before execution and rejects queries
 *   that exceed the key tier budget.
 * - Formats resolver errors with stable codes while redacting internal stack traces.
 */
export async function POST(req: NextRequest) {
  try {
    const rawKey = extractRawApiKey(req)
    if (!rawKey) {
      return NextResponse.json(
        {
          data: null,
          errors: [
            {
              message: 'API key is required via X-API-Key or Authorization Bearer header',
              extensions: { code: 'UNAUTHENTICATED' },
            },
          ],
        },
        { status: 401 },
      )
    }

    const hashedKey = hashApiKey(rawKey)
    const apiKeyRecord = (await prisma.apiKey.findUnique({
      where: { hashedKey },
    })) as Record<string, any> | null

    if (
      !apiKeyRecord ||
      apiKeyRecord.isActive === false ||
      (apiKeyRecord.deactivatesAt &&
        new Date(apiKeyRecord.deactivatesAt).getTime() <= Date.now())
    ) {
      return NextResponse.json(
        {
          data: null,
          errors: [
            {
              message: 'Invalid, inactive, or expired API key',
              extensions: { code: 'INVALID_API_KEY' },
            },
          ],
        },
        { status: 401 },
      )
    }

    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return NextResponse.json(
        {
          data: null,
          errors: [
            {
              message: 'Invalid JSON request body',
              extensions: { code: 'BAD_REQUEST' },
            },
          ],
        },
        { status: 400 },
      )
    }

    const query = typeof body.query === 'string' ? body.query.trim() : ''
    if (!query) {
      return NextResponse.json(
        {
          data: null,
          errors: [
            {
              message: 'GraphQL query string is required',
              extensions: { code: 'BAD_GRAPHQL_REQUEST' },
            },
          ],
        },
        { status: 400 },
      )
    }

    const scopes: string[] = Array.isArray(apiKeyRecord.scopes)
      ? apiKeyRecord.scopes.map((s: unknown) => String(s).toLowerCase())
      : ['graphql:execute']

    const rawTier = String(apiKeyRecord.tier ?? 'free')
      .trim()
      .toLowerCase()
    const tier: GatewayTier =
      rawTier === 'enterprise' || rawTier === 'pro' ? rawTier : 'free'
    const budget = GATEWAY_TIER_BUDGETS[tier]

    const isProd =
      process.env.NODE_ENV === 'production' ||
      req.headers.get('x-gateway-env')?.toLowerCase() === 'production'

    if (isIntrospectionQuery(query) && isProd) {
      const hasSchemaScope = scopes.some((s) => SCHEMA_SCOPES.has(s))
      if (!hasSchemaScope) {
        return NextResponse.json(
          {
            data: null,
            errors: [
              {
                message:
                  'GraphQL introspection is disabled in production unless the API key carries the schema scope',
                extensions: { code: 'INTROSPECTION_FORBIDDEN' },
              },
            ],
          },
          { status: 403 },
        )
      }
    }

    // Analyze depth and weighted field complexity BEFORE executing any resolver
    const { depth, complexity, rootFields } =
      analyzeQueryDepthAndComplexity(query)

    if (depth > budget.maxDepth) {
      return NextResponse.json(
        {
          data: null,
          errors: [
            {
              message: `Query depth ${depth} exceeds ${tier} tier maximum depth of ${budget.maxDepth}`,
              extensions: {
                code: 'QUERY_DEPTH_EXCEEDED',
                tier,
                depth,
                maxDepth: budget.maxDepth,
              },
            },
          ],
        },
        { status: 422 },
      )
    }

    if (complexity > budget.maxComplexity) {
      return NextResponse.json(
        {
          data: null,
          errors: [
            {
              message: `Query complexity ${complexity} exceeds ${tier} tier budget of ${budget.maxComplexity}`,
              extensions: {
                code: 'QUERY_COMPLEXITY_EXCEEDED',
                tier,
                complexity,
                maxComplexity: budget.maxComplexity,
              },
            },
          ],
        },
        { status: 422 },
      )
    }

    // Execute resolvers
    const data: Record<string, unknown> = {}
    const errors: Array<{
      message: string
      path: string[]
      extensions: { code: string }
    }> = []

    const ownerUserId = String(apiKeyRecord.userId)
    const variables =
      body.variables && typeof body.variables === 'object'
        ? (body.variables as Record<string, unknown>)
        : {}

    try {
      if (isIntrospectionQuery(query)) {
        data.__schema = {
          queryType: { name: 'Query' },
          mutationType: { name: 'Mutation' },
          types: [{ name: 'User' }, { name: 'Invoice' }, { name: 'CreditNote' }],
        }
      }

      if (/\bme\b/.test(query)) {
        const user = await prisma.user.findUnique({
          where: { id: ownerUserId },
          select: {
            id: true,
            email: true,
            name: true,
            homeCurrency: true,
          },
        })
        data.me = user
      }

      if (/\binvoices\b/.test(query)) {
        const invoices = await prisma.invoice.findMany({
          where: { userId: ownerUserId },
          take: 20,
        })
        data.invoices = invoices
      } else if (/\binvoice\b/.test(query)) {
        const idMatch = query.match(/invoice\s*\(\s*id\s*:\s*"([^"]+)"/)
        const invoiceId =
          (typeof variables.id === 'string' && variables.id) ||
          (idMatch ? idMatch[1] : '')
        const inv = invoiceId
          ? await prisma.invoice.findUnique({
              where: { id: invoiceId },
            })
          : null
        data.invoice = inv && inv.userId === ownerUserId ? inv : null
      }
    } catch (resolverErr) {
      const formattedErr = formatRedactedGraphqlError(
        resolverErr,
        rootFields.length > 0 ? [rootFields[0]] : ['query'],
      )
      errors.push(formattedErr)
    }

    if (errors.length > 0) {
      return NextResponse.json(
        {
          data: null,
          errors,
          extensions: {
            tier,
            depth,
            complexity,
          },
        },
        { status: 200 },
      )
    }

    return NextResponse.json({
      data,
      extensions: {
        tier,
        depth,
        complexity,
        maxDepth: budget.maxDepth,
        maxComplexity: budget.maxComplexity,
      },
    })
  } catch (err) {
    logger?.error?.({ err }, 'POST /api/graphql gateway error')
    return NextResponse.json(
      {
        data: null,
        errors: [
          {
            message: 'Internal GraphQL gateway error',
            extensions: { code: 'INTERNAL_SERVER_ERROR' },
          },
        ],
      },
      { status: 500 },
    )
  }
}
