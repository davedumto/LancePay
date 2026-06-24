import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const walletFindUnique = vi.fn()
const getAccountBalance = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    wallet: { findUnique: walletFindUnique },
  },
}))
vi.mock('@/lib/stellar', () => ({
  getAccountBalance,
}))
vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/wallet'

function makeRequest(method: string, token: string | null = 'valid-token') {
  const headers = new Headers()
  if (token) {
    headers.set('authorization', `Bearer ${token}`)
  }
  return new NextRequest(BASE_URL, {
    method,
    headers,
  })
}

describe('GET /api/routes-d/wallet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 if no authorization header is provided', async () => {
    const { GET } = await import('@/app/api/routes-d/wallet/route')
    const res = await GET(makeRequest('GET', null))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Unauthorized')
  })

  it('returns 401 if token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/wallet/route')
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Invalid token')
  })

  it('returns 401 if user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    findUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/wallet/route')
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('User not found')
  })

  it('returns wallet: null if user has no wallet', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    walletFindUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/wallet/route')
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ wallet: null })
  })

  it('returns wallet with balances when successful', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    
    const mockDate = new Date('2025-01-01T00:00:00.000Z')
    walletFindUnique.mockResolvedValue({
      id: 'wallet-1',
      userId: 'user-1',
      address: 'GABC123',
      createdAt: mockDate,
    })

    getAccountBalance.mockResolvedValue([
      { asset_type: 'native', balance: '10.5' },
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', balance: '100.00' }
    ])

    const { GET } = await import('@/app/api/routes-d/wallet/route')
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(200)
    
    const json = await res.json()
    expect(json).toEqual({
      wallet: {
        id: 'wallet-1',
        stellarAddress: 'GABC123',
        network: 'testnet',
        createdAt: mockDate.toISOString(),
        balances: [
          { asset_type: 'native', balance: '10.5' },
          { asset_type: 'credit_alphanum4', asset_code: 'USDC', balance: '100.00' }
        ]
      }
    })
    
    expect(getAccountBalance).toHaveBeenCalledWith('GABC123')
  })

  it('returns wallet with empty balances if getting balances fails', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    
    const mockDate = new Date('2025-01-01T00:00:00.000Z')
    walletFindUnique.mockResolvedValue({
      id: 'wallet-1',
      userId: 'user-1',
      address: 'GABC123',
      createdAt: mockDate,
    })

    getAccountBalance.mockRejectedValue(new Error('Network error'))

    const { GET } = await import('@/app/api/routes-d/wallet/route')
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(200)
    
    const json = await res.json()
    expect(json).toEqual({
      wallet: {
        id: 'wallet-1',
        stellarAddress: 'GABC123',
        network: 'testnet',
        createdAt: mockDate.toISOString(),
        balances: []
      }
    })
  })

  it('returns 500 on unexpected database error', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    findUnique.mockRejectedValue(new Error('DB connection lost'))
    const { GET } = await import('@/app/api/routes-d/wallet/route')
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('Failed to get wallet')
  })
})
