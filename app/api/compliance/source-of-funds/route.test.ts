import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GET, POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    sourceOfFundsDeclaration: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUserId = 'user-123'
const mockPrivyId = 'privy-123'

function makeRequest(method: 'GET' | 'POST', body?: Record<string, unknown>) {
  return new NextRequest('http://localhost:3000/api/compliance/source-of-funds', {
    method,
    headers: { Authorization: 'Bearer valid-token' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: mockPrivyId } as { userId: string })
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: mockUserId } as never)
})

describe('GET /api/compliance/source-of-funds', () => {
  it('returns the source of funds declaration for the authenticated user', async () => {
    const mockDeclaration = {
      id: 'decl-1',
      userId: mockUserId,
      sourceType: 'employment',
      details: 'Salary from full-time job',
      monthlyVolumeUsdc: 5000,
      annualIncomeUsdc: 60000,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    vi.mocked(prisma.sourceOfFundsDeclaration.findUnique).mockResolvedValue(mockDeclaration as never)

    const res = await GET(makeRequest('GET'))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.declaration.id).toBe('decl-1')
    expect(data.declaration.sourceType).toBe('employment')
    expect(data.declaration.monthlyVolumeUsdc).toBe(5000)
  })

  it('returns 404 when no declaration exists', async () => {
    vi.mocked(prisma.sourceOfFundsDeclaration.findUnique).mockResolvedValue(null)
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(404)
  })

  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest('http://localhost:3000/api/compliance/source-of-funds')
    const res = await GET(request)
    expect(res.status).toBe(401)
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.sourceOfFundsDeclaration.findUnique).mockRejectedValue(new Error('Database error'))
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(500)
  })
})

describe('POST /api/compliance/source-of-funds', () => {
  it('creates a new source of funds declaration', async () => {
    const mockDeclaration = {
      id: 'decl-1',
      userId: mockUserId,
      sourceType: 'employment',
      details: 'Salary from full-time job',
      monthlyVolumeUsdc: 5000,
      annualIncomeUsdc: 60000,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    vi.mocked(prisma.sourceOfFundsDeclaration.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.sourceOfFundsDeclaration.upsert).mockResolvedValue(mockDeclaration as never)

    const res = await POST(
      makeRequest('POST', {
        sourceType: 'employment',
        details: 'Salary from full-time job',
        monthlyVolumeUsdc: 5000,
        annualIncomeUsdc: 60000,
      }),
    )
    const data = await res.json()

    expect(res.status).toBe(201)
    expect(data.declaration.sourceType).toBe('employment')
    expect(prisma.sourceOfFundsDeclaration.upsert).toHaveBeenCalledWith({
      where: { userId: mockUserId },
      update: expect.objectContaining({
        sourceType: 'employment',
        details: 'Salary from full-time job',
      }),
      create: expect.objectContaining({
        userId: mockUserId,
        sourceType: 'employment',
        details: 'Salary from full-time job',
      }),
    })
  })

  it('updates an existing declaration via upsert', async () => {
    const mockDeclaration = {
      id: 'decl-1',
      userId: mockUserId,
      sourceType: 'investment',
      details: 'Investment returns',
      monthlyVolumeUsdc: 10000,
      annualIncomeUsdc: 120000,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    vi.mocked(prisma.sourceOfFundsDeclaration.findUnique).mockResolvedValue(mockDeclaration as never)
    vi.mocked(prisma.sourceOfFundsDeclaration.upsert).mockResolvedValue(mockDeclaration as never)

    const res = await POST(
      makeRequest('POST', {
        sourceType: 'investment',
        details: 'Investment returns',
        monthlyVolumeUsdc: 10000,
        annualIncomeUsdc: 120000,
      }),
    )
    const data = await res.json()

    expect(res.status).toBe(201)
    expect(data.declaration.sourceType).toBe('investment')
  })

  it('rejects invalid sourceType', async () => {
    const res = await POST(
      makeRequest('POST', {
        sourceType: 'invalid',
        details: 'Some details',
      }),
    )
    expect(res.status).toBe(400)
  })

  it('rejects empty details', async () => {
    const res = await POST(
      makeRequest('POST', {
        sourceType: 'employment',
        details: '',
      }),
    )
    expect(res.status).toBe(400)
  })

  it('rejects negative monthlyVolumeUsdc', async () => {
    const res = await POST(
      makeRequest('POST', {
        sourceType: 'employment',
        details: 'Salary',
        monthlyVolumeUsdc: -100,
      }),
    )
    expect(res.status).toBe(400)
  })

  it('rejects negative annualIncomeUsdc', async () => {
    const res = await POST(
      makeRequest('POST', {
        sourceType: 'employment',
        details: 'Salary',
        annualIncomeUsdc: -1000,
      }),
    )
    expect(res.status).toBe(400)
  })

  it('allows zero for monthlyVolumeUsdc and annualIncomeUsdc', async () => {
    const mockDeclaration = {
      id: 'decl-1',
      userId: mockUserId,
      sourceType: 'employment',
      details: 'Salary',
      monthlyVolumeUsdc: 0,
      annualIncomeUsdc: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    vi.mocked(prisma.sourceOfFundsDeclaration.upsert).mockResolvedValue(mockDeclaration as never)

    const res = await POST(
      makeRequest('POST', {
        sourceType: 'employment',
        details: 'Salary',
        monthlyVolumeUsdc: 0,
        annualIncomeUsdc: 0,
      }),
    )
    expect(res.status).toBe(201)
  })

  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest('http://localhost:3000/api/compliance/source-of-funds', {
      method: 'POST',
      body: JSON.stringify({ sourceType: 'employment', details: 'Salary' }),
    })
    const res = await POST(request)
    expect(res.status).toBe(401)
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.sourceOfFundsDeclaration.upsert).mockRejectedValue(new Error('Database error'))
    const res = await POST(
      makeRequest('POST', {
        sourceType: 'employment',
        details: 'Salary',
      }),
    )
    expect(res.status).toBe(500)
  })
})
