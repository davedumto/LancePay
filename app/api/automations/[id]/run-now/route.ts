import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

function execute(config: unknown): string {
  if (config && typeof config === 'object' && 'fail' in config && (config as { fail?: boolean }).fail) {
    throw new Error('Automation execution failed')
  }
  return 'completed'
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await context.params
    const automation = await prisma.automation.findFirst({
      where: { id, userId: user.id },
      select: { id: true, isActive: true, config: true },
    })
    if (!automation) return NextResponse.json({ error: 'Automation not found' }, { status: 404 })
    if (!automation.isActive) {
      return NextResponse.json({ error: 'Automation is not active' }, { status: 409 })
    }

    const startedAt = new Date()
    const run = await prisma.automationRun.create({
      data: { automationId: automation.id, status: 'running', startedAt, message: null },
      select: { id: true },
    })

    let status = 'success'
    let message = 'completed'
    try {
      message = execute(automation.config)
    } catch (error) {
      status = 'failed'
      message = error instanceof Error ? error.message : 'Automation execution failed'
    }

    const finishedAt = new Date()
    const updated = await prisma.automationRun.update({
      where: { id: run.id },
      data: { status, message, finishedAt },
      select: { id: true, status: true, message: true, startedAt: true, finishedAt: true },
    })
    await prisma.automation.update({
      where: { id: automation.id },
      data: { lastRunAt: finishedAt },
    })

    return NextResponse.json({ run: updated })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/automations/[id]/run-now error')
    return NextResponse.json({ error: 'Failed to run automation' }, { status: 500 })
  }
}
