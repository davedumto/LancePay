import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    emergencyRecovery: { findUnique: vi.fn() },
    emergencyRecoveryApproval: { findUnique: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { GET, POST } from './route'

const context = { params: Promise.resolve({ id: 'recovery-1' }) }
const recovery = {
  id: 'recovery-1',
  status: 'pending',
  expiresAt: new Date(Date.now() + 60_000),
  wallet: { signers: [{ userId: 'admin-1' }] },
  approvals: [],
}

function makeRequest(method: 'GET' | 'POST', body?: unknown) {
  return new NextRequest('http://localhost/api/wallet-signers/emergency-recovery/recovery-1/approvals', {
    method,
    headers: { authorization: 'Bearer token' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'admin-1', role: 'admin' } as any)
  vi.mocked(prisma.emergencyRecovery.findUnique).mockResolvedValue(recovery as any)
  vi.mocked(prisma.emergencyRecoveryApproval.findUnique).mockResolvedValue(null)
  vi.mocked(prisma.emergencyRecoveryApproval.create).mockImplementation((async (args: any) => ({
    id: 'approval-1',
    createdAt: new Date(),
    ...args.data,
  })) as any)
})

describe('emergency recovery approvals', () => {
  it('lists decisions for an eligible admin signer', async () => {
    const response = await GET(makeRequest('GET'), context)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ recoveryId: 'recovery-1', status: 'pending', approvals: [] })
  })

  it('records an approval using schema field names', async () => {
    const response = await POST(makeRequest('POST', { decision: 'approve', note: 'Reviewed' }), context)
    expect(response.status).toBe(201)
    expect(prisma.emergencyRecoveryApproval.create).toHaveBeenCalledWith({
      data: { recoveryId: 'recovery-1', approverId: 'admin-1', decision: 'approve', note: 'Reviewed' },
    })
  })

  it.each(['approved', 'deny', '', null])('rejects invalid decision %p', async (decision) => {
    const response = await POST(makeRequest('POST', { decision }), context)
    expect(response.status).toBe(400)
    expect(prisma.emergencyRecoveryApproval.create).not.toHaveBeenCalled()
  })

  it('rejects a non-admin', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'admin-1', role: 'user' } as any)
    const response = await POST(makeRequest('POST', { decision: 'approve' }), context)
    expect(response.status).toBe(403)
  })

  it('rejects an admin who is not a signer on this recovery wallet', async () => {
    vi.mocked(prisma.emergencyRecovery.findUnique).mockResolvedValue({
      ...recovery,
      wallet: { signers: [{ userId: 'another-admin' }] },
    } as any)
    const response = await POST(makeRequest('POST', { decision: 'reject' }), context)
    expect(response.status).toBe(403)
    expect(prisma.emergencyRecoveryApproval.create).not.toHaveBeenCalled()
  })

  it('rejects a second decision by the same admin', async () => {
    vi.mocked(prisma.emergencyRecoveryApproval.findUnique).mockResolvedValue({ id: 'existing' } as any)
    const response = await POST(makeRequest('POST', { decision: 'reject' }), context)
    expect(response.status).toBe(409)
    expect(prisma.emergencyRecoveryApproval.create).not.toHaveBeenCalled()
  })

  it('maps a concurrent unique-constraint collision to 409', async () => {
    vi.mocked(prisma.emergencyRecoveryApproval.create).mockRejectedValue({ code: 'P2002' })
    const response = await POST(makeRequest('POST', { decision: 'approve' }), context)
    expect(response.status).toBe(409)
  })

  it('does not accept decisions after recovery expiry', async () => {
    vi.mocked(prisma.emergencyRecovery.findUnique).mockResolvedValue({
      ...recovery,
      expiresAt: new Date(Date.now() - 1),
    } as any)
    const response = await POST(makeRequest('POST', { decision: 'approve' }), context)
    expect(response.status).toBe(409)
  })
})