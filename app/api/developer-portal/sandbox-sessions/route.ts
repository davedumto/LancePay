import { randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { DEFAULT_SANDBOX_SEED, generateSandboxDataset, type SandboxDataset } from '@/lib/sandbox-seed'
import { isUniqueConstraintError, requireWalletActor } from '@/app/api/_lib/collective-wallet-auth'

const SANDBOX_DEFAULT_TTL_SECONDS = 60 * 60
const SANDBOX_MIN_TTL_SECONDS = 5 * 60
const SANDBOX_MAX_TTL_SECONDS = 24 * 60 * 60

const createSandboxSessionSchema = z.object({
  apiKeyId: z.string().trim().min(1, 'apiKeyId is required'),
  ttlSeconds: z
    .number()
    .int('ttlSeconds must be an integer')
    .min(SANDBOX_MIN_TTL_SECONDS, `ttlSeconds must be at least ${SANDBOX_MIN_TTL_SECONDS}`)
    .max(SANDBOX_MAX_TTL_SECONDS, `ttlSeconds must be at most ${SANDBOX_MAX_TTL_SECONDS}`)
    .default(SANDBOX_DEFAULT_TTL_SECONDS),
  seed: z.string().trim().min(1).max(64).default(DEFAULT_SANDBOX_SEED),
})

const SESSION_SELECT = {
  id: true,
  apiKeyId: true,
  status: true,
  seed: true,
  expiresAt: true,
  createdAt: true,
} as const

function activeSessionConflict(existing?: { id: string; expiresAt: Date }) {
  return NextResponse.json(
    {
      error: 'This developer app already has an active sandbox session',
      code: 'SANDBOX_SESSION_ACTIVE',
      ...(existing ? { details: { sessionId: existing.id, expiresAt: existing.expiresAt } } : {}),
    },
    { status: 409 }
  )
}

/**
 * POST /api/developer-portal/sandbox-sessions
 * Provision an isolated sandbox for one of the caller's developer apps (API keys).
 *
 * - Seeds a reproducible set of users, wallets and invoices, namespaced by the
 *   session id and stored on the session itself, so no live rows are touched.
 * - Only one active session per app: a still-live session yields 409. Sessions
 *   past expiresAt are marked expired first so they don't block a new one, and
 *   the partial unique index on (apiKeyId) WHERE status = 'active' closes the
 *   race between concurrent creates.
 * - expiresAt (now + ttlSeconds) plus the (status, expiresAt) index let a
 *   sweeper find and reclaim expired sessions.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = createSandboxSessionSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const { apiKeyId, ttlSeconds, seed } = parsed.data
    const now = new Date()

    const apiKey = await prisma.apiKey.findFirst({
      where: { id: apiKeyId, userId: actor.id },
      select: { id: true, isActive: true, deactivatesAt: true },
    })
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Developer app not found', code: 'API_KEY_NOT_FOUND' },
        { status: 404 }
      )
    }
    if (!apiKey.isActive || (apiKey.deactivatesAt && apiKey.deactivatesAt <= now)) {
      return NextResponse.json(
        { error: 'Cannot create a sandbox for an inactive API key', code: 'API_KEY_INACTIVE' },
        { status: 409 }
      )
    }

    const sessionId = randomUUID()
    const seedData: SandboxDataset = generateSandboxDataset(sessionId, seed)
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000)

    const result = await prisma.$transaction(async (tx) => {
      await tx.sandboxSession.updateMany({
        where: { apiKeyId, status: 'active', expiresAt: { lte: now } },
        data: { status: 'expired' },
      })

      const existing = await tx.sandboxSession.findFirst({
        where: { apiKeyId, status: 'active' },
        select: { id: true, expiresAt: true },
      })
      if (existing) return { existing }

      const session = await tx.sandboxSession.create({
        data: {
          id: sessionId,
          apiKeyId,
          userId: actor.id,
          status: 'active',
          seed,
          seedData: seedData as unknown as Prisma.InputJsonValue,
          expiresAt,
        },
        select: SESSION_SELECT,
      })
      return { session }
    })

    if ('existing' in result) return activeSessionConflict(result.existing)

    logger.info(
      { sessionId, apiKeyId, userId: actor.id, ttlSeconds },
      'Sandbox session created'
    )

    return NextResponse.json({ session: result.session, data: seedData }, { status: 201 })
  } catch (error) {
    // Lost a race with a concurrent create for the same app.
    if (isUniqueConstraintError(error)) return activeSessionConflict()
    logger.error({ err: error }, 'POST /api/developer-portal/sandbox-sessions error')
    return NextResponse.json({ error: 'Failed to create sandbox session' }, { status: 500 })
  }
}
