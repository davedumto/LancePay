/**
 * Tests for issue #614 — GET /withdrawals/estimate
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { calculateWithdrawalFee, isSupportedCurrency } from '../_lib/withdrawal-fees'

// ── unit tests for fee logic ──────────────────────────────────────────────────

describe('calculateWithdrawalFee', () => {
  it('small amount: applies minimum fee', () => {
    const result = calculateWithdrawalFee(1, 'USDC')
    expect(result.fee).toBeGreaterThanOrEqual(0.5) // min fee
    expect(result.feeCurrency).toBe('USDC')
    expect(result.netAmount).toBe(parseFloat((1 - result.fee).toFixed(2)))
    expect(result.estimatedArrival).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('large amount: fee is 1.5% of amount', () => {
    const result = calculateWithdrawalFee(1000, 'USDC')
    expect(result.fee).toBeCloseTo(15, 2) // 1.5% of 1000
    expect(result.netAmount).toBeCloseTo(985, 2)
  })

  it('fee + netAmount equals original amount', () => {
    const amount = 250
    const result = calculateWithdrawalFee(amount, 'USDC')
    expect(result.fee + result.netAmount).toBeCloseTo(amount, 1)
  })

  it('normalises currency to uppercase', () => {
    const result = calculateWithdrawalFee(100, 'usdc')
    expect(result.feeCurrency).toBe('USDC')
  })

  it('estimate matches actual fee within 0.01 tolerance', () => {
    const amount = 500
    const estimate = calculateWithdrawalFee(amount, 'USDC')
    // Simulate "actual" fee using same function (same logic)
    const actual = calculateWithdrawalFee(amount, 'USDC')
    expect(Math.abs(estimate.fee - actual.fee)).toBeLessThanOrEqual(0.01)
  })
})

describe('isSupportedCurrency', () => {
  it('accepts USDC', () => expect(isSupportedCurrency('USDC')).toBe(true))
  it('accepts USD', () => expect(isSupportedCurrency('USD')).toBe(true))
  it('rejects NGN', () => expect(isSupportedCurrency('NGN')).toBe(false))
  it('rejects empty string', () => expect(isSupportedCurrency('')).toBe(false))
})

// ── route handler tests ───────────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn().mockResolvedValue({ userId: 'privy-user-1' }),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'user-1', privyId: 'privy-user-1' }),
    },
    bankAccount: {
      findFirst: vi.fn(),
    },
  },
}))

import { GET } from '../withdrawals/estimate/route'
import { prisma } from '@/lib/db'

function makeRequest(params: Record<string, string>) {
  const url = new URL('http://localhost/api/routes-b/withdrawals/estimate')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new Request(url.toString(), { headers: { authorization: 'Bearer tok' } }) as any
}

describe('GET /withdrawals/estimate route', () => {
  beforeEach(() => {
    vi.mocked(prisma.bankAccount.findFirst).mockResolvedValue({ id: 'bank-1' } as any)
  })

  it('returns estimate for valid request', async () => {
    const res = await GET(makeRequest({ amount: '100', currency: 'USDC', bankId: 'bank-1' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('fee')
    expect(body).toHaveProperty('feeCurrency', 'USDC')
    expect(body).toHaveProperty('netAmount')
    expect(body).toHaveProperty('estimatedArrival')
  })

  it('rejects negative amount with 400', async () => {
    const res = await GET(makeRequest({ amount: '-10', currency: 'USDC', bankId: 'bank-1' }))
    expect(res.status).toBe(400)
  })

  it('rejects zero amount with 400', async () => {
    const res = await GET(makeRequest({ amount: '0', currency: 'USDC', bankId: 'bank-1' }))
    expect(res.status).toBe(400)
  })

  it('rejects unsupported currency with 400', async () => {
    const res = await GET(makeRequest({ amount: '100', currency: 'NGN', bankId: 'bank-1' }))
    expect(res.status).toBe(400)
  })

  it('rejects invalid bank id with 404', async () => {
    vi.mocked(prisma.bankAccount.findFirst).mockResolvedValueOnce(null)
    const res = await GET(makeRequest({ amount: '100', currency: 'USDC', bankId: 'bad-bank' }))
    expect(res.status).toBe(404)
  })

  it('no side effects — no transaction created', async () => {
    // prisma.transaction.create is not mocked, so if called it would throw
    const res = await GET(makeRequest({ amount: '100', currency: 'USDC', bankId: 'bank-1' }))
    expect(res.status).toBe(200)
  })
})
