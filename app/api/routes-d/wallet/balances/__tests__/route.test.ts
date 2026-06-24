import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  verifyAuthToken: vi.fn(),
  userFindUnique: vi.fn(),
  getAccountBalance: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: mocks.verifyAuthToken,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: mocks.userFindUnique,
    },
  },
}))

vi.mock('@/lib/stellar', () => ({
  getAccountBalance: mocks.getAccountBalance,
}))

import { GET } from '../route'

const BASE_URL = 'http://localhost/api/routes-d/wallet/balances'

function makeRequest(token: string | null = 'valid-token') {
  const headers = new Headers()
  if (token) {
    headers.set('authorization', `Bearer ${token}`)
  }
  return new NextRequest(BASE_URL, {
    method: 'GET',
    headers,
  })
}

describe('GET /api/routes-d/wallet/balances', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 if no authorization header is provided', async () => {
    const res = await GET(makeRequest(null))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Unauthorized')
  })

  it('returns 401 if token is invalid', async () => {
    mocks.verifyAuthToken.mockResolvedValue(null)
    const res = await GET(makeRequest('invalid-token'))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Invalid token')
  })

  it('returns 401 if user is not found', async () => {
    mocks.verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    mocks.userFindUnique.mockResolvedValue(null)
    const res = await GET(makeRequest('valid-token'))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('User not found')
  })

  it('returns balances: [] if user has no wallet', async () => {
    mocks.verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    mocks.userFindUnique.mockResolvedValue({ id: 'user-1', wallet: null })
    const res = await GET(makeRequest('valid-token'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ balances: [] })
  })

  it('returns wallet balances when successful', async () => {
    mocks.verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    mocks.userFindUnique.mockResolvedValue({
      id: 'user-1',
      wallet: { id: 'wallet-1', address: 'GABC123' },
    })
    mocks.getAccountBalance.mockResolvedValue([
      { asset_type: 'native', balance: '10.5' },
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', balance: '100.00' },
    ])

    const res = await GET(makeRequest('valid-token'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.balances).toHaveLength(2)
    expect(json.balances[0].balance).toBe('10.5')
    expect(mocks.getAccountBalance).toHaveBeenCalledWith('GABC123')
  })

  it('returns balances: [] if getting balances fails', async () => {
    mocks.verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    mocks.userFindUnique.mockResolvedValue({
      id: 'user-1',
      wallet: { id: 'wallet-1', address: 'GABC123' },
    })
    mocks.getAccountBalance.mockRejectedValue(new Error('Horizon offline'))

    const res = await GET(makeRequest('valid-token'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ balances: [] })
  })
})
