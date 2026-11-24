import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    automation: { findFirst: vi.fn(), update: vi.fn() },
    automationRun: { create: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

function call(id = 'auto-1') {
  return POST(new NextRequest('http://localhost/api/automations/auto-1/run-now', {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
  }), { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
  vi.mocked(prisma.automationRun.create).mockResolvedValue({ id: 'run-1' } as never)
  vi.mocked(prisma.automationRun.update).mockResolvedValue({ id: 'run-1', status: 'success' } as never)
  vi.mocked(prisma.automation.update).mockResolvedValue({} as never)
})

describe('POST /api/automations/[id]/run-now', () => {
  it('rejects an inactive automation before creating a run', async () => {
    vi.mocked(prisma.automation.findFirst).mockResolvedValue({ id: 'auto-1', isActive: false, config: null } as never)
    const res = await call()
    expect(res.status).toBe(409)
    expect(prisma.automationRun.create).not.toHaveBeenCalled()
    expect(prisma.automation.update).not.toHaveBeenCalled()
  })

  it('records the run before execution and sets lastRunAt only after it finishes', async () => {
    const order: string[] = []
    vi.mocked(prisma.automation.findFirst).mockResolvedValue({ id: 'auto-1', isActive: true, config: {} } as never)
    vi.mocked(prisma.automationRun.create).mockImplementation(async () => {
      order.push('start')
      return { id: 'run-1' } as never
    })
    vi.mocked(prisma.automationRun.update).mockImplementation(async () => {
      order.push('finish')
      return { id: 'run-1', status: 'success' } as never
    })
    vi.mocked(prisma.automation.update).mockImplementation(async () => {
      order.push('lastRunAt')
      return {} as never
    })

    const res = await call()
    expect(res.status).toBe(200)
    expect(order).toEqual(['start', 'finish', 'lastRunAt'])
    expect(prisma.automationRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'running', automationId: 'auto-1' }) }),
    )
  })

  it('still finishes the run when execution throws', async () => {
    vi.mocked(prisma.automation.findFirst).mockResolvedValue({
      id: 'auto-1',
      isActive: true,
      config: { fail: true },
    } as never)
    vi.mocked(prisma.automationRun.update).mockResolvedValue({ id: 'run-1', status: 'failed' } as never)
    const res = await call()
    expect(res.status).toBe(200)
    expect(prisma.automationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed', message: 'Automation execution failed' }),
      }),
    )
    expect(prisma.automation.update).toHaveBeenCalled()
  })
})
