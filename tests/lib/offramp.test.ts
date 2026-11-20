import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  initiateOfframp,
  getOfframpWithdrawalStatus,
  OfframpError,
  OfframpUnknownOutcomeError,
} from '@/lib/offramp'

const PARAMS = {
  amount: 25,
  reference: 'wd_abc123',
  bankAccount: {
    accountNumber: '0123456789',
    bankCode: '044',
    accountName: 'Jane Doe',
  },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function lastFetchCall(): { url: string; init: RequestInit } {
  const calls = vi.mocked(fetch).mock.calls
  const [url, init] = calls[calls.length - 1]
  return { url: String(url), init: init as RequestInit }
}

describe('initiateOfframp', () => {
  beforeEach(() => {
    vi.stubEnv('OFFRAMP_API_KEY', 'key')
    vi.stubEnv('OFFRAMP_API_SECRET', 'secret')
    vi.stubEnv('OFFRAMP_API_URL', 'https://offramp.example.com')
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('posts to /withdrawals with an Idempotency-Key and abort signal', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ transactionId: 'offramp-tx-1', status: 'pending' }),
    )

    const result = await initiateOfframp(PARAMS)

    expect(result).toEqual({ transactionId: 'offramp-tx-1', status: 'pending' })
    const { url, init } = lastFetchCall()
    expect(url).toBe('https://offramp.example.com/withdrawals')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBe('wd_abc123')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('sends params.reference as the Idempotency-Key so provider retries dedupe', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ transactionId: 'offramp-tx-1', status: 'pending' }),
    )

    // A caller retry with the same reference must carry the same key —
    // the provider returns the original payout instead of a second one.
    await initiateOfframp(PARAMS)
    await initiateOfframp(PARAMS)

    const calls = vi.mocked(fetch).mock.calls
    for (const [, init] of calls) {
      expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBe(
        'wd_abc123',
      )
    }
  })

  it('throws OfframpUnknownOutcomeError on timeout — outcome is unknown', async () => {
    vi.mocked(fetch).mockRejectedValue(
      new DOMException('The operation timed out', 'TimeoutError'),
    )

    await expect(initiateOfframp(PARAMS)).rejects.toBeInstanceOf(
      OfframpUnknownOutcomeError,
    )
    await expect(initiateOfframp(PARAMS)).rejects.toMatchObject({
      outcome: 'unknown',
    })
  })

  it('throws OfframpUnknownOutcomeError on AbortError', async () => {
    vi.mocked(fetch).mockRejectedValue(
      new DOMException('Aborted', 'AbortError'),
    )

    await expect(initiateOfframp(PARAMS)).rejects.toBeInstanceOf(
      OfframpUnknownOutcomeError,
    )
  })

  it('rethrows non-timeout network errors unchanged', async () => {
    const networkError = new TypeError('fetch failed')
    vi.mocked(fetch).mockRejectedValue(networkError)

    await expect(initiateOfframp(PARAMS)).rejects.toBe(networkError)
  })

  it('throws OfframpError with httpStatus on provider error responses', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ error: 'insufficient balance' }, 422),
    )

    await expect(initiateOfframp(PARAMS)).rejects.toMatchObject({
      name: 'OfframpError',
      httpStatus: 422,
      message: 'insufficient balance',
    })
  })

  it('handles a non-JSON error response without masking the status', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('<html>Bad Gateway</html>', { status: 502 }),
    )

    const promise = initiateOfframp(PARAMS)
    await expect(promise).rejects.toBeInstanceOf(OfframpError)
    await expect(promise).rejects.toMatchObject({ httpStatus: 502 })
  })

  it('throws when offramp API configuration is missing', async () => {
    vi.unstubAllEnvs()
    await expect(initiateOfframp(PARAMS)).rejects.toThrow(
      'Off-ramp API configuration missing',
    )
  })
})

describe('getOfframpWithdrawalStatus', () => {
  beforeEach(() => {
    vi.stubEnv('OFFRAMP_API_KEY', 'key')
    vi.stubEnv('OFFRAMP_API_SECRET', 'secret')
    vi.stubEnv('OFFRAMP_API_URL', 'https://offramp.example.com')
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('returns the withdrawal status by reference', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ transactionId: 'offramp-tx-1', status: 'completed' }),
    )

    const result = await getOfframpWithdrawalStatus('wd_abc123')

    expect(result).toEqual({ transactionId: 'offramp-tx-1', status: 'completed' })
    const { url, init } = lastFetchCall()
    expect(url).toBe('https://offramp.example.com/withdrawals/wd_abc123')
    expect(init.method).toBe('GET')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('returns null when the provider has no record (404)', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('not found', { status: 404 }))

    await expect(getOfframpWithdrawalStatus('wd_missing')).resolves.toBeNull()
  })

  it('throws OfframpUnknownOutcomeError on lookup timeout', async () => {
    vi.mocked(fetch).mockRejectedValue(
      new DOMException('The operation timed out', 'TimeoutError'),
    )

    await expect(getOfframpWithdrawalStatus('wd_abc123')).rejects.toBeInstanceOf(
      OfframpUnknownOutcomeError,
    )
  })
})
