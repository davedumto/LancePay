import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Keypair } from '@stellar/stellar-sdk'

const { mockVerifyAuthToken, mockServer } = vi.hoisted(() => ({
  mockVerifyAuthToken: vi.fn(),
  mockServer: {
    strictSendPaths: vi.fn(),
    strictReceivePaths: vi.fn(),
  },
}))

vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/stellar', () => ({ server: mockServer }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { POST, MAX_PATH_HOPS } from './route'

const USDC_ISSUER = Keypair.random().publicKey()
const EURC_ISSUER = Keypair.random().publicKey()
const HOP_ISSUER = Keypair.random().publicKey()

function makePostRequest(
  body: unknown,
  token: string | null = 'valid-token',
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(
    'http://localhost/api/stellar/path-payments/preview',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  )
}

function mockPathfinderCall(records: unknown[]) {
  return {
    limit: () => ({
      call: vi.fn().mockResolvedValue({ records }),
    }),
  }
}

describe('POST /api/stellar/path-payments/preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1' })
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(makePostRequest({}, null))
    expect(res.status).toBe(401)
  })

  it('rejects maxHops exceeding MAX_PATH_HOPS with 400', async () => {
    const res = await POST(
      makePostRequest({
        sourceAsset: { code: 'XLM' },
        destinationAsset: { code: 'USDC', issuer: USDC_ISSUER },
        amount: 100,
        maxHops: MAX_PATH_HOPS + 1,
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('MAX_HOPS_EXCEEDED')
  })

  it('consults both strictSendPaths and strictReceivePaths, filters excessive hops, and returns the better rate with a short expiry', async () => {
    // strictSendPaths returns rate 0.92 (100 USDC -> 92 EURC)
    mockServer.strictSendPaths.mockReturnValueOnce(
      mockPathfinderCall([
        {
          source_amount: '100.0000000',
          destination_amount: '92.0000000',
          path: [{ asset_type: 'native' }],
        },
        // 5-hop path exceeding MAX_PATH_HOPS=4 should be ignored even if rate looks high
        {
          source_amount: '100.0000000',
          destination_amount: '99.0000000',
          path: Array.from({ length: 5 }, (_, i) => ({
            asset_type: 'credit_alphanum4',
            asset_code: `H${i}`,
            asset_issuer: HOP_ISSUER,
          })),
        },
      ]),
    )

    // strictReceivePaths returns a better rate: 95 EURC for 100 USDC (rate 0.95)
    mockServer.strictReceivePaths.mockReturnValueOnce(
      mockPathfinderCall([
        {
          source_amount: '100.0000000',
          destination_amount: '95.0000000',
          path: [
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'AQUA',
              asset_issuer: HOP_ISSUER,
            },
          ],
        },
      ]),
    )

    const beforeMs = Date.now()
    const res = await POST(
      makePostRequest({
        sourceAsset: { code: 'USDC', issuer: USDC_ISSUER },
        destinationAsset: { code: 'EURC', issuer: EURC_ISSUER },
        amount: 100,
        direction: 'send',
      }),
    )
    expect(res.status).toBe(200)
    const { quote } = await res.json()

    expect(mockServer.strictSendPaths).toHaveBeenCalledOnce()
    expect(mockServer.strictReceivePaths).toHaveBeenCalledOnce()
    expect(quote.selectedStrategy).toBe('strict_receive')
    expect(quote.effectiveRate).toBe(0.95)
    expect(quote.hopCount).toBe(1)
    expect(quote.ttlSeconds).toBe(60)

    const expiresMs = new Date(quote.expiresAt).getTime()
    expect(expiresMs).toBeGreaterThan(beforeMs + 50_000)
    expect(expiresMs).toBeLessThanOrEqual(Date.now() + 65_000)
  })

  it('returns 422 when all candidate paths exceed maxHops', async () => {
    mockServer.strictSendPaths.mockReturnValueOnce(
      mockPathfinderCall([
        {
          source_amount: '100.0000000',
          destination_amount: '90.0000000',
          path: [{ asset_type: 'native' }, { asset_type: 'native' }, { asset_type: 'native' }],
        },
      ]),
    )
    mockServer.strictReceivePaths.mockReturnValueOnce(mockPathfinderCall([]))

    const res = await POST(
      makePostRequest({
        sourceAsset: { code: 'USDC', issuer: USDC_ISSUER },
        destinationAsset: { code: 'EURC', issuer: EURC_ISSUER },
        amount: 100,
        maxHops: 2,
      }),
    )
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe('NO_ELIGIBLE_PATH')
  })
})
