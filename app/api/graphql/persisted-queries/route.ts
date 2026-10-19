import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { verifyAuthToken } from '@/lib/auth'

export type GatewayTier = 'free' | 'starter' | 'pro' | 'enterprise'

export const GATEWAY_TIER_LIMITS: Record<GatewayTier, { maxDepth: number; maxComplexity: number }> = {
  free: { maxDepth: 5, maxComplexity: 50 },
  starter: { maxDepth: 8, maxComplexity: 100 },
  pro: { maxDepth: 15, maxComplexity: 300 },
  enterprise: { maxDepth: 25, maxComplexity: 1000 },
}

const registerPersistedQuerySchema = z.object({
  appId: z.string().trim().min(1, 'appId is required'),
  query: z.string().trim().min(1, 'query is required'),
  hash: z.string().trim().min(1).optional(),
  tier: z.enum(['free', 'starter', 'pro', 'enterprise']).optional(),
})

export function normalizeQuery(query: string): string {
  // Strip comments
  const lines = query.split('\n')
  const withoutComments = lines
    .map((line) => {
      const commentIdx = line.indexOf('#')
      return commentIdx >= 0 ? line.slice(0, commentIdx) : line
    })
    .join(' ')
  // Collapse whitespace
  return withoutComments.replace(/\s+/g, ' ').trim()
}

export function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex')
}

export function computeQueryMetrics(query: string): { depth: number; complexity: number } {
  const normalized = normalizeQuery(query)
  let depth = 0
  let maxDepth = 0
  let complexity = 0

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]
    if (char === '{') {
      depth++
      if (depth > maxDepth) maxDepth = depth
    } else if (char === '}') {
      if (depth > 0) depth--
    }
  }

  const words = normalized
    .replace(/[{}():,$!@]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

  const nonFieldKeywords = new Set([
    'query',
    'mutation',
    'subscription',
    'fragment',
    'on',
    'true',
    'false',
    'null',
  ])

  for (const w of words) {
    if (!nonFieldKeywords.has(w)) {
      complexity++
    }
  }

  return { depth: maxDepth, complexity: Math.max(complexity, 1) }
}

async function resolveCallerTier(request: NextRequest, bodyTier?: string): Promise<GatewayTier> {
  if (bodyTier && bodyTier in GATEWAY_TIER_LIMITS) {
    return bodyTier as GatewayTier
  }

  const headerTier = request.headers.get('x-gateway-tier')?.toLowerCase()
  if (headerTier && headerTier in GATEWAY_TIER_LIMITS) {
    return headerTier as GatewayTier
  }

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (authToken) {
    const claims = await verifyAuthToken(authToken)
    if (claims?.userId) {
      const user = await prisma.user.findUnique({
        where: { privyId: claims.userId },
        select: {
          role: true,
        },
      })
      if (user?.role === 'admin') return 'enterprise'
    }
  }

  return 'free'
}

/**
 * POST /api/graphql/persisted-queries
 *
 * Registers a hash-based persisted query for a developer app.
 * - Computes SHA256 of the normalized query and rejects hash mismatches.
 * - Rejects queries whose depth or complexity exceeds the gateway thresholds for caller's tier.
 * - Stores the registration keyed by developer app + hash.
 */
export async function POST(request: NextRequest) {
  try {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = registerPersistedQuerySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }

    const { appId, query, hash: callerHash, tier: bodyTier } = parsed.data
    const normalized = normalizeQuery(query)
    if (!normalized || normalized.length === 0) {
      return NextResponse.json({ error: 'Query body cannot be empty' }, { status: 400 })
    }

    const computedHash = computeSha256(normalized)

    if (callerHash && callerHash.toLowerCase() !== computedHash.toLowerCase()) {
      return NextResponse.json(
        {
          error: `Query hash mismatch: expected ${callerHash}, computed ${computedHash}`,
          code: 'HASH_MISMATCH',
          expected: callerHash,
          computed: computedHash,
        },
        { status: 400 },
      )
    }

    const tier = await resolveCallerTier(request, bodyTier)
    const limits = GATEWAY_TIER_LIMITS[tier]
    const { depth, complexity } = computeQueryMetrics(query)

    if (depth > limits.maxDepth) {
      return NextResponse.json(
        {
          error: `Query depth ${depth} exceeds maximum allowed depth of ${limits.maxDepth} for tier ${tier}`,
          code: 'GATEWAY_DEPTH_EXCEEDED',
          depth,
          maxDepth: limits.maxDepth,
          tier,
        },
        { status: 400 },
      )
    }

    if (complexity > limits.maxComplexity) {
      return NextResponse.json(
        {
          error: `Query complexity ${complexity} exceeds maximum allowed complexity of ${limits.maxComplexity} for tier ${tier}`,
          code: 'GATEWAY_COMPLEXITY_EXCEEDED',
          complexity,
          maxComplexity: limits.maxComplexity,
          tier,
        },
        { status: 400 },
      )
    }

    // Keyed by developer app + hash so same query text under different app is distinct
    const existing = await prisma.persistedQuery.findUnique({
      where: {
        appId_hash: {
          appId,
          hash: computedHash,
        },
      },
    })

    if (existing) {
      return NextResponse.json(
        {
          persistedQuery: existing,
          alreadyRegistered: true,
          message: 'Query already registered for this developer app',
        },
        { status: 200 },
      )
    }

    const persistedQuery = await prisma.persistedQuery.create({
      data: {
        appId,
        hash: computedHash,
        query,
        normalized,
        depth,
        complexity,
      },
    })

    logger.info(
      { appId, hash: computedHash, depth, complexity, tier },
      'Persisted query registered',
    )

    return NextResponse.json(
      {
        persistedQuery,
        alreadyRegistered: false,
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/graphql/persisted-queries error')
    return NextResponse.json({ error: 'Failed to register persisted query' }, { status: 500 })
  }
}
