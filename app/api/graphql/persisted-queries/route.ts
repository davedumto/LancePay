import { createHash, randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireWalletActor } from '@/app/api/_lib/collective-wallet-auth'

export type DeveloperTier = 'free' | 'pro' | 'enterprise'

export interface TierGatewayThresholds {
  maxDepth: number
  maxComplexity: number
}

export const GATEWAY_TIER_THRESHOLDS: Record<DeveloperTier, TierGatewayThresholds> =
  Object.freeze({
    free: { maxDepth: 5, maxComplexity: 30 },
    pro: { maxDepth: 10, maxComplexity: 120 },
    enterprise: { maxDepth: 15, maxComplexity: 300 },
  })

const registerPersistedQuerySchema = z.object({
  developerAppId: z.string().trim().min(1, 'developerAppId is required'),
  query: z.string().trim().min(1, 'query is required'),
  hash: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{64}$/, 'hash must be a 64-character SHA-256 hex string')
    .optional(),
  operationName: z.string().trim().min(1).max(128).optional(),
})

export interface RegisteredPersistedQuery {
  id: string
  developerAppId: string
  hash: string
  normalizedQuery: string
  operationName: string | null
  depth: number
  complexity: number
  tier: DeveloperTier
  createdAt: string
}

const persistedRegistry = new Map<string, RegisteredPersistedQuery>()

export function clearPersistedQueryRegistry(): void {
  persistedRegistry.clear()
}

export function getPersistedQueryRegistrySize(): number {
  return persistedRegistry.size
}

/**
 * Normalizes a GraphQL document by stripping comments, trimming, and collapsing
 * redundant whitespace and token separators into a canonical representation.
 */
export function normalizeGraphqlQuery(rawQuery: string): string {
  const withoutComments = rawQuery
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, ''))
    .join(' ')
  return withoutComments
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}():,])\s*/g, '$1')
    .trim()
}

export function computeNormalizedQueryHash(normalizedQuery: string): string {
  return createHash('sha256').update(normalizedQuery, 'utf8').digest('hex')
}

/**
 * Computes structural nesting depth and field complexity of a normalized GraphQL query.
 */
export function analyzeGraphqlQuery(normalizedQuery: string): {
  valid: boolean
  depth: number
  complexity: number
} {
  let currentDepth = 0
  let maxDepth = 0
  let openBraces = 0

  for (let i = 0; i < normalizedQuery.length; i++) {
    const ch = normalizedQuery[i]
    if (ch === '{') {
      currentDepth += 1
      openBraces += 1
      if (currentDepth > maxDepth) maxDepth = currentDepth
    } else if (ch === '}') {
      currentDepth -= 1
      if (currentDepth < 0) {
        return { valid: false, depth: 0, complexity: 0 }
      }
    }
  }

  if (currentDepth !== 0 || openBraces === 0) {
    return { valid: false, depth: 0, complexity: 0 }
  }

  // Operation root { ... } is level 1; nested selection sets inside fields count toward field depth
  const fieldDepth = maxDepth

  // Estimate complexity from selection tokens and nested levels
  const withoutOperationHeader = normalizedQuery.replace(
    /^(query|mutation|subscription)\s*[A-Za-z0-9_]*\s*(\([^)]*\))?\s*/,
    ''
  )
  const fieldTokens = withoutOperationHeader
    .replace(/[{}(),:]/g, ' ')
    .split(/\s+/)
    .filter((tok) => tok.length > 0 && !tok.startsWith('$'))

  const complexity = Math.max(1, fieldTokens.length + Math.max(0, fieldDepth - 1) * 2)

  return {
    valid: true,
    depth: fieldDepth,
    complexity,
  }
}

function resolveTier(apiKey: any, user: any): DeveloperTier {
  const raw = String(apiKey?.tier ?? user?.tier ?? 'free')
    .trim()
    .toLowerCase()
  if (raw === 'enterprise') return 'enterprise'
  if (raw === 'pro') return 'pro'
  return 'free'
}

/**
 * POST /api/graphql/persisted-queries
 *
 * Registers a persisted GraphQL query scoped to `(developerAppId, hash)`:
 * - Computes SHA-256 of the normalized GraphQL query and rejects caller hash mismatches (422).
 * - Rejects queries whose depth or complexity exceeds the gateway thresholds for the caller's tier (422).
 * - Stores registrations keyed by `(developerAppId, hash)` so identical queries under different
 *   developer apps are distinct entries.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = registerPersistedQuerySchema.safeParse(rawBody)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const { developerAppId, query, hash: providedHash, operationName } = parsed.data
    const now = new Date()

    const apiKey: any = await prisma.apiKey.findFirst({
      where: { id: developerAppId, userId: actor.id },
    })

    if (!apiKey) {
      return NextResponse.json(
        { error: 'Developer app not found', code: 'API_KEY_NOT_FOUND' },
        { status: 404 }
      )
    }

    if (!apiKey.isActive || (apiKey.deactivatesAt && apiKey.deactivatesAt <= now)) {
      return NextResponse.json(
        { error: 'Developer app is inactive', code: 'API_KEY_INACTIVE' },
        { status: 409 }
      )
    }

    const normalizedQuery = normalizeGraphqlQuery(query)
    const analysis = analyzeGraphqlQuery(normalizedQuery)

    if (!analysis.valid) {
      return NextResponse.json(
        {
          error: 'Malformed GraphQL query syntax (unbalanced selection braces)',
          code: 'INVALID_GRAPHQL_SYNTAX',
        },
        { status: 400 }
      )
    }

    const computedHash = computeNormalizedQueryHash(normalizedQuery)

    if (providedHash && providedHash.toLowerCase() !== computedHash) {
      return NextResponse.json(
        {
          error: 'Provided query hash does not match SHA-256 of the normalized GraphQL query',
          code: 'QUERY_HASH_MISMATCH',
          details: {
            providedHash: providedHash.toLowerCase(),
            computedHash,
          },
        },
        { status: 422 }
      )
    }

    const tier = resolveTier(apiKey, actor)
    const thresholds = GATEWAY_TIER_THRESHOLDS[tier]

    if (analysis.depth > thresholds.maxDepth) {
      return NextResponse.json(
        {
          error: `Query depth (${analysis.depth}) exceeds gateway limit (${thresholds.maxDepth}) for tier "${tier}"`,
          code: 'QUERY_DEPTH_EXCEEDED',
          details: {
            depth: analysis.depth,
            maxDepth: thresholds.maxDepth,
            tier,
          },
        },
        { status: 422 }
      )
    }

    if (analysis.complexity > thresholds.maxComplexity) {
      return NextResponse.json(
        {
          error: `Query complexity (${analysis.complexity}) exceeds gateway limit (${thresholds.maxComplexity}) for tier "${tier}"`,
          code: 'QUERY_COMPLEXITY_EXCEEDED',
          details: {
            complexity: analysis.complexity,
            maxComplexity: thresholds.maxComplexity,
            tier,
          },
        },
        { status: 422 }
      )
    }

    const compositeKey = `${developerAppId}:${computedHash}`
    const existing = persistedRegistry.get(compositeKey)
    if (existing) {
      return NextResponse.json(
        {
          persistedQuery: existing,
          created: false,
        },
        { status: 200 }
      )
    }

    const entry: RegisteredPersistedQuery = {
      id: `pq_${randomUUID()}`,
      developerAppId,
      hash: computedHash,
      normalizedQuery,
      operationName: operationName ?? null,
      depth: analysis.depth,
      complexity: analysis.complexity,
      tier,
      createdAt: now.toISOString(),
    }

    const dbModel = (prisma as any)?.persistedGraphqlQuery
    if (dbModel && typeof dbModel.upsert === 'function') {
      await dbModel.upsert({
        where: {
          developerAppId_hash: {
            developerAppId,
            hash: computedHash,
          },
        },
        create: {
          id: entry.id,
          developerAppId,
          hash: computedHash,
          query: normalizedQuery,
          operationName: entry.operationName,
          depth: entry.depth,
          complexity: entry.complexity,
        },
        update: {},
      })
    }

    persistedRegistry.set(compositeKey, entry)

    logger.info(
      {
        developerAppId,
        hash: computedHash,
        depth: entry.depth,
        complexity: entry.complexity,
        tier,
      },
      'Persisted GraphQL query registered'
    )

    return NextResponse.json(
      {
        persistedQuery: entry,
        created: true,
      },
      { status: 201 }
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/graphql/persisted-queries error')
    return NextResponse.json(
      { error: 'Failed to register persisted GraphQL query' },
      { status: 500 }
    )
  }
}
