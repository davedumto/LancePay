import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { generateSandboxDataset, type SandboxDataset } from '@/lib/sandbox-seed'
import { requireWalletActor } from '@/app/api/_lib/collective-wallet-auth'

export const SANDBOX_JOB_RETRY_AFTER_SECONDS = 5

const resetSandboxSchema = z
  .object({
    seed: z.string().trim().min(1).max(64).optional(),
  })
  .optional()

interface RouteContext {
  params: Promise<{ id: string }> | { id: string }
}

function hasInFlightJobInSeedData(seedData: unknown): boolean {
  if (!seedData || typeof seedData !== 'object') return false
  const obj = seedData as Record<string, unknown>
  if (typeof obj.inFlightJobCount === 'number' && obj.inFlightJobCount > 0) {
    return true
  }
  if (Array.isArray(obj.inFlightJobs) && obj.inFlightJobs.length > 0) {
    return true
  }
  return false
}

function extractResetCount(session: any): number {
  if (typeof session?.resetCount === 'number') {
    return session.resetCount
  }
  const meta = session?.seedData?._meta
  if (meta && typeof meta.resetCount === 'number') {
    return meta.resetCount
  }
  return 0
}

/**
 * POST /api/developer-portal/sandbox-sessions/[id]/reset
 *
 * Resets an active sandbox session to its clean seeded baseline without destroying
 * the session identifier (`id`):
 * - Executes inside a single `prisma.$transaction` so partial resets never leave
 *   orphaned sandbox rows.
 * - Rejects reset requests while a sandbox job is in-flight against the session
 *   with HTTP 409 Conflict and a `Retry-After` header.
 * - Bumps `resetCount` and `lastResetAt` on the session.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    const resolvedParams = await Promise.resolve(context.params)
    const sessionId = resolvedParams?.id?.trim()
    if (!sessionId) {
      return NextResponse.json({ error: 'Session id is required' }, { status: 400 })
    }

    let parsedSeed: string | undefined
    const rawText = await request.text()
    if (rawText.trim().length > 0) {
      let jsonBody: unknown
      try {
        jsonBody = JSON.parse(rawText)
      } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
      }
      const parsed = resetSandboxSchema.safeParse(jsonBody)
      if (!parsed.success) {
        return NextResponse.json(
          { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
          { status: 400 }
        )
      }
      parsedSeed = parsed.data?.seed
    }

    const now = new Date()

    const txOutcome = await prisma.$transaction(async (tx) => {
      const session: any = await tx.sandboxSession.findFirst({
        where: { id: sessionId },
      })

      if (!session) {
        return { kind: 'not_found' as const }
      }

      if (session.userId !== actor.id) {
        return { kind: 'forbidden' as const }
      }

      if (session.status !== 'active' || (session.expiresAt && session.expiresAt <= now)) {
        if (session.status === 'active' && session.expiresAt && session.expiresAt <= now) {
          await tx.sandboxSession.updateMany({
            where: { id: session.id, status: 'active' },
            data: { status: 'expired' },
          })
        }
        return { kind: 'expired' as const }
      }

      // Check for in-flight sandbox jobs (both lock table and session state)
      let inFlightJob =
        session.status === 'busy' || hasInFlightJobInSeedData(session.seedData)

      const jobLockModel = (tx as any).distributedJobLock
      if (!inFlightJob && jobLockModel && typeof jobLockModel.findFirst === 'function') {
        const activeLock = await jobLockModel.findFirst({
          where: {
            jobName: `sandbox:${session.id}`,
            expiresAt: { gt: now },
          },
        })
        if (activeLock) inFlightJob = true
      }

      const sandboxJobModel = (tx as any).sandboxJob
      if (!inFlightJob && sandboxJobModel && typeof sandboxJobModel.count === 'function') {
        const count = await sandboxJobModel.count({
          where: {
            sessionId: session.id,
            status: { in: ['pending', 'running', 'in_flight'] },
          },
        })
        if (count > 0) inFlightJob = true
      }

      if (inFlightJob) {
        return { kind: 'in_flight' as const }
      }

      // Clean up any completed/stale sandbox job rows scoped to this session inside the same tx
      if (sandboxJobModel && typeof sandboxJobModel.deleteMany === 'function') {
        await sandboxJobModel.deleteMany({
          where: { sessionId: session.id },
        })
      }

      const effectiveSeed = parsedSeed ?? session.seed
      const cleanBaseline: SandboxDataset = generateSandboxDataset(session.id, effectiveSeed)
      const nextResetCount = extractResetCount(session) + 1

      const nextSeedData = {
        ...cleanBaseline,
        _meta: {
          resetCount: nextResetCount,
          lastResetAt: now.toISOString(),
        },
      }

      const updated = await tx.sandboxSession.update({
        where: { id: session.id },
        data: {
          seed: effectiveSeed,
          seedData: nextSeedData as unknown as Prisma.InputJsonValue,
          updatedAt: now,
        },
      })

      return {
        kind: 'reset' as const,
        session: {
          id: updated?.id ?? session.id,
          apiKeyId: updated?.apiKeyId ?? session.apiKeyId,
          status: updated?.status ?? session.status,
          seed: effectiveSeed,
          resetCount: nextResetCount,
          lastResetAt: now.toISOString(),
          expiresAt: updated?.expiresAt ?? session.expiresAt,
          createdAt: updated?.createdAt ?? session.createdAt,
        },
        data: cleanBaseline,
      }
    })

    if (txOutcome.kind === 'not_found') {
      return NextResponse.json(
        { error: 'Sandbox session not found', code: 'SANDBOX_SESSION_NOT_FOUND' },
        { status: 404 }
      )
    }

    if (txOutcome.kind === 'forbidden') {
      return NextResponse.json(
        { error: 'Forbidden: you do not own this sandbox session', code: 'FORBIDDEN' },
        { status: 403 }
      )
    }

    if (txOutcome.kind === 'expired') {
      return NextResponse.json(
        {
          error: 'Cannot reset an expired or inactive sandbox session',
          code: 'SANDBOX_SESSION_EXPIRED',
        },
        { status: 409 }
      )
    }

    if (txOutcome.kind === 'in_flight') {
      return NextResponse.json(
        {
          error: 'Cannot reset sandbox session while a sandbox job is in-flight',
          code: 'SANDBOX_JOB_IN_FLIGHT',
          retryAfterSeconds: SANDBOX_JOB_RETRY_AFTER_SECONDS,
        },
        {
          status: 409,
          headers: {
            'Retry-After': String(SANDBOX_JOB_RETRY_AFTER_SECONDS),
          },
        }
      )
    }

    logger.info(
      {
        sessionId: txOutcome.session.id,
        userId: actor.id,
        resetCount: txOutcome.session.resetCount,
      },
      'Sandbox session reset to baseline'
    )

    return NextResponse.json(
      {
        session: txOutcome.session,
        data: txOutcome.data,
      },
      { status: 200 }
    )
  } catch (error) {
    logger.error(
      { err: error },
      'POST /api/developer-portal/sandbox-sessions/[id]/reset error'
    )
    return NextResponse.json(
      { error: 'Failed to reset sandbox session' },
      { status: 500 }
    )
  }
}
