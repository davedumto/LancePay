import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireWalletActor } from '@/app/api/_lib/collective-wallet-auth'

export interface PersistedGraphqlQueryEntry {
  id: string
  developerAppId: string
  hash: string
  query: string
  operationName: string | null
  depth: number
  complexity: number
  accessCount: number
  lastAccessedAt: Date | null
  createdAt: Date
}

const persistedQueryStore = new Map<string, PersistedGraphqlQueryEntry>()

export function seedPersistedQueryForTest(entry: PersistedGraphqlQueryEntry): void {
  persistedQueryStore.set(
    `${entry.developerAppId}:${entry.hash.toLowerCase()}`,
    entry
  )
}

export function clearPersistedQueryStore(): void {
  persistedQueryStore.clear()
}

const SHA256_HEX_REGEX = /^[0-9a-fA-F]{64}$/

export const INDISTINGUISHABLE_404_BODY = Object.freeze({
  error: 'Persisted query not found',
  code: 'PERSISTED_QUERY_NOT_FOUND',
})

function indistinguishableNotFound(): NextResponse {
  return NextResponse.json(INDISTINGUISHABLE_404_BODY, { status: 404 })
}

interface RouteContext {
  params: Promise<{ hash: string }> | { hash: string }
}

/**
 * GET /api/graphql/persisted-queries/[hash]
 *
 * Resolves a persisted GraphQL query by SHA-256 hash scoped to the caller's
 * developer app (`developerAppId` / `apiKeyId`):
 * - Returns an indistinguishable 404 between "not registered" and "not authorized"
 *   (registered to another developer app).
 * - Rejects lookups when the parent developer app is disabled (403 DEVELOPER_APP_DISABLED)
 *   or when its environment mode (sandbox vs live) mismatches the gateway mode
 *   (403 GATEWAY_MODE_MISMATCH).
 * - Increments and records a lightweight `accessCount` and `lastAccessedAt`.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    const resolvedParams = await Promise.resolve(context.params)
    const rawHash = resolvedParams?.hash?.trim() ?? ''
    if (!SHA256_HEX_REGEX.test(rawHash)) {
      return NextResponse.json(
        {
          error: 'Invalid persisted query hash. Expected a 64-character SHA-256 hex digest.',
          code: 'INVALID_QUERY_HASH',
        },
        { status: 400 }
      )
    }

    const hash = rawHash.toLowerCase()
    const { searchParams } = new URL(request.url)
    const developerAppId =
      (
        request.headers.get('x-developer-app-id') ??
        searchParams.get('developerAppId') ??
        searchParams.get('apiKeyId')
      )?.trim() ?? ''

    if (!developerAppId) {
      return NextResponse.json(
        {
          error: 'developerAppId is required via X-Developer-App-Id header or query parameter',
          code: 'MISSING_DEVELOPER_APP_ID',
        },
        { status: 400 }
      )
    }

    const gatewayModeRaw = (
      request.headers.get('x-gateway-mode') ??
      searchParams.get('gatewayMode') ??
      'live'
    )
      .trim()
      .toLowerCase()

    if (gatewayModeRaw !== 'live' && gatewayModeRaw !== 'sandbox') {
      return NextResponse.json(
        { error: 'Invalid gatewayMode. Must be "live" or "sandbox".', code: 'INVALID_GATEWAY_MODE' },
        { status: 400 }
      )
    }

    const now = new Date()

    const apiKey: any = await prisma.apiKey.findFirst({
      where: { id: developerAppId, userId: actor.id },
    })

    // Return the exact same 404 when the caller does not own the developerAppId
    // so an attacker cannot probe query hashes or app ownership.
    if (!apiKey) {
      return indistinguishableNotFound()
    }

    if (!apiKey.isActive || (apiKey.deactivatesAt && apiKey.deactivatesAt <= now)) {
      return NextResponse.json(
        {
          error: 'Parent developer app is disabled or deactivated',
          code: 'DEVELOPER_APP_DISABLED',
        },
        { status: 403 }
      )
    }

    // Determine developer app mode (explicit mode field, keyHint prefix, or active SandboxSession)
    let appMode: 'live' | 'sandbox' =
      apiKey.mode === 'sandbox' ||
      (typeof apiKey.keyHint === 'string' && apiKey.keyHint.startsWith('sbx_'))
        ? 'sandbox'
        : 'live'

    if (appMode === 'live' && prisma.sandboxSession?.findFirst) {
      const activeSandbox = await prisma.sandboxSession.findFirst({
        where: {
          apiKeyId: developerAppId,
          status: 'active',
          expiresAt: { gt: now },
        },
        select: { id: true },
      })
      if (activeSandbox) {
        appMode = 'sandbox'
      }
    }

    if (appMode !== gatewayModeRaw) {
      return NextResponse.json(
        {
          error: `Developer app mode (${appMode}) mismatches gateway mode (${gatewayModeRaw})`,
          code: 'GATEWAY_MODE_MISMATCH',
          details: { appMode, gatewayMode: gatewayModeRaw },
        },
        { status: 403 }
      )
    }

    const dbModel = (prisma as any)?.persistedGraphqlQuery
    const storeKey = `${developerAppId}:${hash}`
    let entry: PersistedGraphqlQueryEntry | null = persistedQueryStore.get(storeKey) ?? null

    if (!entry && dbModel && typeof dbModel.findFirst === 'function') {
      const row = await dbModel.findFirst({
        where: { developerAppId, hash },
      })
      if (row) {
        entry = {
          id: row.id,
          developerAppId: row.developerAppId,
          hash: row.hash,
          query: row.query,
          operationName: row.operationName ?? null,
          depth: row.depth ?? 1,
          complexity: row.complexity ?? 1,
          accessCount: Number(row.accessCount ?? 0),
          lastAccessedAt: row.lastAccessedAt ?? null,
          createdAt: row.createdAt ?? now,
        }
      }
    }

    if (!entry) {
      return indistinguishableNotFound()
    }

    const nextAccessCount = entry.accessCount + 1
    entry.accessCount = nextAccessCount
    entry.lastAccessedAt = now
    persistedQueryStore.set(storeKey, entry)

    if (dbModel && typeof dbModel.update === 'function') {
      await dbModel
        .update({
          where: { id: entry.id },
          data: {
            accessCount: { increment: 1 },
            lastAccessedAt: now,
          },
        })
        .catch(() => {
          // Non-blocking lightweight access count update
        })
    }

    return NextResponse.json(
      {
        persistedQuery: {
          hash: entry.hash,
          developerAppId: entry.developerAppId,
          query: entry.query,
          operationName: entry.operationName,
          depth: entry.depth,
          complexity: entry.complexity,
          accessCount: nextAccessCount,
          lastAccessedAt: now.toISOString(),
        },
      },
      { status: 200 }
    )
  } catch (error) {
    logger.error({ err: error }, 'GET /api/graphql/persisted-queries/[hash] error')
    return NextResponse.json(
      { error: 'Failed to lookup persisted GraphQL query' },
      { status: 500 }
    )
  }
}
