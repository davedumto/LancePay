import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initiateSep24Session } from '@/lib/sep24'

const ANCHOR_ENV = {
  MONEYGRAM_CLIENT_ID: 'mg-client',
  MONEYGRAM_CLIENT_SECRET: 'mg-secret',
  MONEYGRAM_SEP24_ENDPOINT: 'https://anchor.example.com',
}

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      jwt: 'jwt-token-123',
      interactive_url: 'https://anchor.example.com/interactive?token=abc',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function lastRequest(): { url: string; body: Record<string, unknown> } {
  const calls = vi.mocked(fetch).mock.calls
  const [url, init] = calls[calls.length - 1]
  return {
    url: String(url),
    body: JSON.parse(String(init?.body)) as Record<string, unknown>,
  }
}

describe('initiateSep24Session', () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(ANCHOR_ENV)) {
      vi.stubEnv(key, value)
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse()))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('posts to the deposit interactive endpoint for direction=deposit', async () => {
    const result = await initiateSep24Session('moneygram', {
      direction: 'deposit',
      assetCode: 'USDC',
      account: 'user-1',
      amount: '10.00',
    })

    expect(result).toEqual({
      jwtToken: 'jwt-token-123',
      interactiveUrl: 'https://anchor.example.com/interactive?token=abc',
    })
    const { url, body } = lastRequest()
    expect(url).toBe(
      'https://anchor.example.com/sep24/transactions/deposit/interactive',
    )
    expect(body).toMatchObject({
      asset_code: 'USDC',
      account: 'user-1',
      amount: '10.00',
    })
  })

  it('posts to the withdraw interactive endpoint for direction=withdraw', async () => {
    await initiateSep24Session('moneygram', {
      direction: 'withdraw',
      assetCode: 'NGN',
      account: 'user-1',
      amount: 5000,
      memo: 'cash-out',
    })

    const { url, body } = lastRequest()
    // A cash-out must hit the withdraw endpoint, not deposit.
    expect(url).toBe(
      'https://anchor.example.com/sep24/transactions/withdraw/interactive',
    )
    expect(url).not.toContain('/deposit/')
    expect(body).toMatchObject({
      asset_code: 'NGN',
      account: 'user-1',
      amount: '5000',
      memo: 'cash-out',
    })
  })

  it('never sends the custom userId field', async () => {
    await initiateSep24Session('moneygram', {
      direction: 'withdraw',
      assetCode: 'USDC',
      account: 'user-1',
    })

    const { body } = lastRequest()
    expect(body).not.toHaveProperty('userId')
    expect(body).not.toHaveProperty('user_id')
  })

  it('defaults asset_code to USDC and omits unset optional fields', async () => {
    await initiateSep24Session('moneygram', {
      direction: 'withdraw',
      account: 'user-1',
    })

    const { body } = lastRequest()
    expect(body.asset_code).toBe('USDC')
    expect(body).not.toHaveProperty('amount')
    expect(body).not.toHaveProperty('memo')
  })

  it('throws on an invalid direction', async () => {
    await expect(
      initiateSep24Session('moneygram', {
        direction: 'sideways' as never,
        account: 'user-1',
      }),
    ).rejects.toThrow('Invalid SEP-24 direction')
  })

  it('throws when anchor credentials are missing', async () => {
    vi.stubEnv('MONEYGRAM_CLIENT_SECRET', '')

    await expect(
      initiateSep24Session('moneygram', {
        direction: 'withdraw',
        account: 'user-1',
      }),
    ).rejects.toThrow('Anchor credentials not configured')
  })

  it('propagates non-OK anchor responses with the direction in the message', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'account not found' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(
      initiateSep24Session('moneygram', {
        direction: 'withdraw',
        account: 'user-1',
      }),
    ).rejects.toThrow('SEP-24 withdraw endpoint returned 400')
  })
})
