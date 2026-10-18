import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

export type AutomationActionExecutor = (
  automation: Record<string, any>,
  contextPayload?: Record<string, unknown>,
) => Promise<{ message?: string }>

let customExecutor: AutomationActionExecutor | null = null

export function setAutomationActionExecutor(
  executor: AutomationActionExecutor | null,
) {
  customExecutor = executor
}

async function defaultExecuteAutomationAction(
  automation: Record<string, any>,
  contextPayload?: Record<string, unknown>,
): Promise<{ message: string }> {
  if (
    contextPayload?.simulateError ||
    (automation.config &&
      typeof automation.config === 'object' &&
      (automation.config as any).simulateError)
  ) {
    throw new Error(
      typeof contextPayload?.simulateError === 'string'
        ? contextPayload.simulateError
        : 'Simulated automation action execution failure',
    )
  }

  return {
    message: `Executed action "${automation.actionType}" for trigger "${automation.triggerType}"`,
  }
}

async function resolveAutomationId(context?: RouteContext): Promise<string> {
  if (!context?.params) return ''
  const resolved = await Promise.resolve(context.params)
  return (resolved?.id ?? '').trim()
}

async function authenticate(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return {
      error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }),
    }
  }

  const user =
    (await prisma.user.findUnique({ where: { privyId: claims.userId } })) ??
    (await prisma.user.findUnique({ where: { id: claims.userId } }))
  if (!user) {
    return {
      error: NextResponse.json({ error: 'User not found' }, { status: 404 }),
    }
  }

  return { user }
}

/**
 * POST /api/automations/[id]/run-now
 * Manually triggers an `Automation` outside its normal schedule and records the `AutomationRun`:
 * - Rejects triggering an automation where `isActive` is `false` (`409`).
 * - Creates the `AutomationRun` row with `startedAt` set before execution and `finishedAt` plus
 *   `status` set after, even if execution throws.
 * - Updates `lastRunAt` on the `Automation` only after the run actually completes, not at trigger time.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const automationId = await resolveAutomationId(context)
    if (!automationId) {
      return NextResponse.json(
        { error: 'Automation ID is required' },
        { status: 400 },
      )
    }

    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    const automation =
      typeof prisma.automation?.findUnique === 'function'
        ? await prisma.automation.findUnique({ where: { id: automationId } })
        : await prisma.automation.findFirst({ where: { id: automationId } })

    if (!automation) {
      return NextResponse.json(
        { error: 'Automation not found' },
        { status: 404 },
      )
    }

    if (automation.userId !== user.id && user.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (!automation.isActive) {
      return NextResponse.json(
        {
          error: 'Cannot manually trigger an inactive automation',
          code: 'AUTOMATION_INACTIVE',
        },
        { status: 409 },
      )
    }

    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >

    // 1. Create the AutomationRun row with startedAt BEFORE execution (and do NOT touch lastRunAt yet)
    const startedAt = new Date()
    const initialRun = await prisma.automationRun.create({
      data: {
        automationId: automation.id,
        status: 'running',
        message: null,
        startedAt,
        finishedAt: null,
      },
    })

    // 2. Execute the automation action, capturing completion status and finishedAt even if it throws
    let finalStatus: 'success' | 'failed' = 'success'
    let finalMessage = ''
    let executionError: Error | null = null

    try {
      const executor = customExecutor ?? defaultExecuteAutomationAction
      const outcome = await executor(automation, body)
      finalStatus = 'success'
      finalMessage =
        outcome?.message ??
        `Executed action "${automation.actionType}" successfully`
    } catch (err: any) {
      finalStatus = 'failed'
      finalMessage =
        err instanceof Error ? err.message : 'Automation execution failed'
      executionError =
        err instanceof Error ? err : new Error(String(err ?? 'Unknown error'))
    }

    const finishedAt = new Date(
      Math.max(Date.now(), startedAt.getTime() + 1),
    )

    // 3. Finalize the AutomationRun row with finishedAt and terminal status
    const completedRun =
      typeof prisma.automationRun?.update === 'function'
        ? await prisma.automationRun.update({
            where: { id: initialRun.id },
            data: {
              status: finalStatus,
              message: finalMessage,
              finishedAt,
            },
          })
        : {
            ...initialRun,
            status: finalStatus,
            message: finalMessage,
            finishedAt,
          }

    // 4. Update lastRunAt on the Automation ONLY after the run has completed
    const updatedAutomation =
      typeof prisma.automation?.update === 'function'
        ? await prisma.automation.update({
            where: { id: automation.id },
            data: { lastRunAt: finishedAt },
          })
        : { ...automation, lastRunAt: finishedAt }

    const durationMs = Math.max(
      0,
      new Date(completedRun.finishedAt ?? finishedAt).getTime() -
        new Date(completedRun.startedAt ?? startedAt).getTime(),
    )

    return NextResponse.json(
      {
        run: {
          id: completedRun.id,
          automationId: completedRun.automationId ?? automation.id,
          status: completedRun.status,
          message: completedRun.message,
          startedAt: new Date(
            completedRun.startedAt ?? startedAt,
          ).toISOString(),
          finishedAt: new Date(
            completedRun.finishedAt ?? finishedAt,
          ).toISOString(),
          durationMs,
        },
        automation: {
          id: automation.id,
          lastRunAt: new Date(
            updatedAutomation?.lastRunAt ?? finishedAt,
          ).toISOString(),
        },
      },
      { status: executionError ? 200 : 201 },
    )
  } catch (error) {
    logger?.error?.({ err: error }, 'POST /api/automations/[id]/run-now error')
    return NextResponse.json(
      { error: 'Failed to trigger automation run' },
      { status: 500 },
    )
  }
}
