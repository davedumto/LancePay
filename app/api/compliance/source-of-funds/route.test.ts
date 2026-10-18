import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockPrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  sourceOfFundsDeclaration: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}))

const mockVerifyAuthToken = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { GET, POST } from './route'

describe('GET, POST /api/compliance/source-of-funds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'did:privy:user_sof_1' })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user_sof_1' })
  })

  it('enforces the unique userId constraint by upserting rather than erroring on resubmission', async () => {
    mockPrisma.sourceOfFundsDeclaration.upsert
      .mockResolvedValueOnce({
        id: 'sof_1',
        userId: 'user_sof_1',
        sourceType: 'freelance_services',
        details: 'Full-stack software engineering contracts for US clients',
        monthlyVolumeUsdc: '8000.000000',
        annualIncomeUsdc: '96000.000000',
        createdAt: new Date('2026-06-05T10:00:00.000Z'),
        updatedAt: new Date('2026-06-05T10:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: 'sof_1',
        userId: 'user_sof_1',
        sourceType: 'consulting',
        details: 'Updated: security architecture consulting retainers',
        monthlyVolumeUsdc: '12500.000000',
        annualIncomeUsdc: '150000.000000',
        createdAt: new Date('2026-06-05T10:00:00.000Z'),
        updatedAt: new Date('2026-06-05T10:05:00.000Z'),
      })

    const firstReq = new NextRequest(
      'http://localhost/api/compliance/source-of-funds',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sourceType: 'freelance_services',
          details: 'Full-stack software engineering contracts for US clients',
          monthlyVolumeUsdc: 8000,
          annualIncomeUsdc: 96000,
        }),
      },
    )
    const firstRes = await POST(firstReq)
    expect(firstRes.status).toBe(200)

    const secondReq = new NextRequest(
      'http://localhost/api/compliance/source-of-funds',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sourceType: 'consulting',
          details: 'Updated: security architecture consulting retainers',
          monthlyVolumeUsdc: 12500,
          annualIncomeUsdc: 150000,
        }),
      },
    )
    const secondRes = await POST(secondReq)
    expect(secondRes.status).toBe(200)
    const secondBody = await secondRes.json()

    expect(mockPrisma.sourceOfFundsDeclaration.upsert).toHaveBeenCalledTimes(2)
    expect(mockPrisma.sourceOfFundsDeclaration.upsert).toHaveBeenLastCalledWith({
      where: { userId: 'user_sof_1' },
      update: {
        sourceType: 'consulting',
        details: 'Updated: security architecture consulting retainers',
        monthlyVolumeUsdc: 12500,
        annualIncomeUsdc: 150000,
      },
      create: {
        userId: 'user_sof_1',
        sourceType: 'consulting',
        details: 'Updated: security architecture consulting retainers',
        monthlyVolumeUsdc: 12500,
        annualIncomeUsdc: 150000,
      },
    })
    expect(secondBody.declaration).toMatchObject({
      id: 'sof_1',
      userId: 'user_sof_1',
      sourceType: 'consulting',
      monthlyVolumeUsdc: 12500,
      annualIncomeUsdc: 150000,
    })

    // GET also returns the declaration
    mockPrisma.sourceOfFundsDeclaration.findUnique.mockResolvedValueOnce({
      id: 'sof_1',
      userId: 'user_sof_1',
      sourceType: 'consulting',
      details: 'Updated: security architecture consulting retainers',
      monthlyVolumeUsdc: '12500.000000',
      annualIncomeUsdc: '150000.000000',
      createdAt: new Date('2026-06-05T10:00:00.000Z'),
      updatedAt: new Date('2026-06-05T10:05:00.000Z'),
    })
    const getReq = new NextRequest(
      'http://localhost/api/compliance/source-of-funds',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const getRes = await GET(getReq)
    expect(getRes.status).toBe(200)
  })

  it('validates sourceType against the allowed set and requires details to be non-empty', async () => {
    const badTypeReq = new NextRequest(
      'http://localhost/api/compliance/source-of-funds',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sourceType: 'unregistered_lottery',
          details: 'Some description',
        }),
      },
    )
    const badTypeRes = await POST(badTypeReq)
    expect(badTypeRes.status).toBe(400)
    const badTypeBody = await badTypeRes.json()
    expect(badTypeBody.code).toBe('INVALID_SOURCE_TYPE')

    const emptyDetailsReq = new NextRequest(
      'http://localhost/api/compliance/source-of-funds',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sourceType: 'freelance_services',
          details: '    ',
        }),
      },
    )
    const emptyDetailsRes = await POST(emptyDetailsReq)
    expect(emptyDetailsRes.status).toBe(400)
    const emptyDetailsBody = await emptyDetailsRes.json()
    expect(emptyDetailsBody.code).toBe('DETAILS_REQUIRED')
    expect(mockPrisma.sourceOfFundsDeclaration.upsert).not.toHaveBeenCalled()
  })

  it('validates monthlyVolumeUsdc and annualIncomeUsdc are non-negative when supplied', async () => {
    const negMonthlyReq = new NextRequest(
      'http://localhost/api/compliance/source-of-funds',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sourceType: 'freelance_services',
          details: 'Design services',
          monthlyVolumeUsdc: -500,
        }),
      },
    )
    const negMonthlyRes = await POST(negMonthlyReq)
    expect(negMonthlyRes.status).toBe(400)
    const negMonthlyBody = await negMonthlyRes.json()
    expect(negMonthlyBody.code).toBe('INVALID_AMOUNT_VALUE')

    const negAnnualReq = new NextRequest(
      'http://localhost/api/compliance/source-of-funds',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sourceType: 'freelance_services',
          details: 'Design services',
          monthlyVolumeUsdc: 2000,
          annualIncomeUsdc: -1,
        }),
      },
    )
    const negAnnualRes = await POST(negAnnualReq)
    expect(negAnnualRes.status).toBe(400)
    const negAnnualBody = await negAnnualRes.json()
    expect(negAnnualBody.code).toBe('INVALID_AMOUNT_VALUE')
    expect(mockPrisma.sourceOfFundsDeclaration.upsert).not.toHaveBeenCalled()
  })
})
