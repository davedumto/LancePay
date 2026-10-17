import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Keypair, StrKey } from '@stellar/stellar-sdk'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    wallet: {
      findUnique: vi.fn(),
    },
  },
  mockVerifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { GET } from './route'

const TEST_WALLET = Keypair.random().publicKey()

function makeGetRequest(params = '', token: string | null = 'valid-token'): NextRequest {
  const url = `http://localhost/api/stellar/muxed-accounts/derive${params ? `?${params}` : ''}`
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(url, { method: 'GET', headers })
}

describe('GET /api/stellar/muxed-accounts/derive', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      wallet: { address: TEST_WALLET },
    })
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await GET(makeGetRequest('label=client-retainer', null))
    expect(res.status).toBe(401)
  })

  it('rejects labels that collide with internal reserved namespaces with 422', async () => {
    for (const reserved of ['sys:escrow', 'platform:fees', 'treasury_vault', 'internal:sweep', '__admin']) {
      const res = await GET(makeGetRequest(`label=${encodeURIComponent(reserved)}`))
      expect(res.status).toBe(422)
      const body = await res.json()
      expect(body.code).toBe('RESERVED_MUXED_NAMESPACE')
    }
  })

  it('deterministically derives the same M-address and muxedId for the same label and returns parentAccount', async () => {
    const res1 = await GET(makeGetRequest('label=project-alpha'))
    expect(res1.status).toBe(200)
    const body1 = await res1.json()

    const res2 = await GET(makeGetRequest('label=PROJECT-ALPHA'))
    expect(res2.status).toBe(200)
    const body2 = await res2.json()

    expect(body1.muxedAddress).toBe(body2.muxedAddress)
    expect(body1.muxedId).toBe(body2.muxedId)
    expect(body1.parentAccount).toBe(TEST_WALLET)
    expect(body1.muxedAddress.startsWith('M')).toBe(true)
    expect(StrKey.isValidMed25519PublicKey(body1.muxedAddress)).toBe(true)

    const resDifferent = await GET(makeGetRequest('label=project-beta'))
    const bodyDifferent = await resDifferent.json()
    expect(bodyDifferent.muxedAddress).not.toBe(body1.muxedAddress)
    expect(bodyDifferent.parentAccount).toBe(TEST_WALLET)
  })

  it('returns 404 when the authenticated user has no provisioned wallet', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      wallet: null,
    })
    mockPrisma.wallet.findUnique.mockResolvedValueOnce(null)

    const res = await GET(makeGetRequest('label=sub-account-1'))
    expect(res.status).toBe(404)
  })
})
