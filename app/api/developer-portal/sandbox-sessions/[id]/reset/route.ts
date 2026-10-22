import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { generateSandboxDataset, type SandboxDataset } from '@/lib/sandbox-seed'
import { requireWalletActor } from '@/app/api/_lib/collective-wallet-auth'

const resetSessionSchema = z
  .object({
    seed: z.string().trim().min(1).max(64).optional(),
  })
  .optional()

type RouteContext = {
  params: { id: string } | Promise<{ id: string }>
}

/**
 * POST /api/developer-portal/sandbox-sessions/[id]/reset
 * Resets a sandbox session to the seeded baseline without destroying the session identifier.
 *
 * Requirements:
 * - Perform the reset in a single transaction so partial resets never leave orphaned sandbox rows
 * - Reject reset requests while a sandbox job is in flight against the session, returning a 409 with retry guidance
 * - Bump a reset counter on the session so the developer portal can show the last reset time
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    const resolvedParams = await Promise.resolve(context.params)
    const sessionId = resolvedParams?.id?.trim()

    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session ID is required', code: 'INVALID_SESSION_ID' },
        { status: 400 }
      )
    }

    let parsedSeed: string | undefined
    try {
      const text = await request.text()
      if (text.trim().length > 0) {
        const json = JSON.parse(text)
        const parseResult = resetSessionSchema.safeParse(json)
        if (!parseResult.success) {
          return NextResponse.json(
            { error: 'Invalid request body', details: parseResult.error.flatten().fieldErrors },
            { status: 400 }
          )
        }
        parsedSeed = parseResult.data?.seed
      }
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const now = new Date()

    // Execute in a single atomic transaction
    const txResult = await prisma.$transaction(async (tx) => {
      const existing = await tx.sandboxSession.findUnique({
        where: { id: sessionId },
      })

      if (!existing || existing.userId !== actor.id) {
        return { notFound: true } as const
      }

      if (existing.jobInFlight) {
        return {
          jobInFlight: true,
          activeJobId: existing.activeJobId,
        } as const
      }

      if (existing.status === 'expired' || existing.expiresAt <= now) {
        return { expired: true } as const
      }

      const effectiveSeed = parsedSeed || existing.seed
      const freshDataset: SandboxDataset = generateSandboxDataset(existing.id, effectiveSeed)

      const updated = await tx.sandboxSession.update({
        where: { id: sessionId },
        data: {
          seed: effectiveSeed,
          seedData: freshDataset as unknown as Prisma.InputJsonValue,
          resetCount: { increment: 1 },
          lastResetAt: now,
        },
        select: {
          id: true,
          apiKeyId: true,
          status: true,
          seed: true,
          resetCount: true,
          lastResetAt: true,
          expiresAt: true,
          createdAt: true,
          updatedAt: true,
        },
      })

      return {
        session: updated,
        data: freshDataset,
      } as const
    })

    if ('notFound' in txResult) {
      return NextResponse.json(
        { error: 'Sandbox session not found', code: 'SANDBOX_SESSION_NOT_FOUND' },
        { status: 404 }
      )
    }

    if ('jobInFlight' in txResult) {
      return NextResponse.json(
        {
          error: 'Cannot reset sandbox: a job is currently in flight against this session',
          code: 'SANDBOX_JOB_IN_FLIGHT',
          retryAfterSeconds: 5,
          details: {
            sessionId,
            activeJobId: txResult.activeJobId ?? null,
            retryAfterSeconds: 5,
            guidance: 'A sandbox background job is executing. Retry the reset request after the job finishes.',
          },
        },
        {
          status: 409,
          headers: {
            'Retry-After': '5',
          },
        }
      )
    }

    if ('expired' in txResult) {
      return NextResponse.json(
        { error: 'Cannot reset an expired sandbox session', code: 'SANDBOX_SESSION_EXPIRED' },
        { status: 410 }
      )
    }

    logger.info(
      {
        sessionId: txResult.session.id,
        userId: actor.id,
        resetCount: txResult.session.resetCount,
        lastResetAt: txResult.session.lastResetAt,
      },
      'Sandbox session reset to baseline'
    )

    return NextResponse.json(
      {
        session: txResult.session,
        data: txResult.data,
        resetCount: txResult.session.resetCount,
        lastResetAt: txResult.session.lastResetAt,
      },
      { status: 200 }
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/developer-portal/sandbox-sessions/[id]/reset error')
    return NextResponse.json({ error: 'Failed to reset sandbox session' }, { status: 500 })
  }
}
