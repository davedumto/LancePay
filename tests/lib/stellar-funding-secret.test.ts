import { Keypair } from '@stellar/stellar-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEPRECATED_FUNDING_SECRET_ENV,
  FUNDING_SECRET_ENV,
  getFundingWalletPublicKey,
  resolveFundingSecret,
} from '@/lib/stellar-funding'

const ENV_KEYS = [
  FUNDING_SECRET_ENV,
  DEPRECATED_FUNDING_SECRET_ENV,
  'STELLAR_SPONSOR_SECRET',
  'STELLAR_NETWORK',
] as const

const savedEnv: Record<string, string | undefined> = {}

vi.mock('@/lib/db', () => ({ prisma: {} }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('resolveFundingSecret (#1911)', () => {
  it('returns the canonical name without warning', () => {
    const warn = vi.fn()
    const secret = resolveFundingSecret({ [FUNDING_SECRET_ENV]: 'canonical' }, warn)
    expect(secret).toBe('canonical')
    expect(warn).not.toHaveBeenCalled()
  })

  it('accepts the deprecated alias with one warning naming both variables', () => {
    const warn = vi.fn()
    const secret = resolveFundingSecret({ [DEPRECATED_FUNDING_SECRET_ENV]: 'legacy' }, warn)
    expect(secret).toBe('legacy')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(FUNDING_SECRET_ENV))
    expect(warn.mock.calls[0]![0]).toContain(DEPRECATED_FUNDING_SECRET_ENV)
  })

  it('prefers the canonical name when both are set and warns about the alias', () => {
    const warn = vi.fn()
    const secret = resolveFundingSecret(
      { [FUNDING_SECRET_ENV]: 'canonical', [DEPRECATED_FUNDING_SECRET_ENV]: 'legacy' },
      warn,
    )
    expect(secret).toBe('canonical')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('ignoring the deprecated alias')
  })

  it('returns undefined when neither name is set', () => {
    const warn = vi.fn()
    expect(resolveFundingSecret({}, warn)).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('funding keypair accessor (#1911)', () => {
  it('derives the public key from the canonical variable when both are set', () => {
    const canonical = Keypair.random()
    process.env[FUNDING_SECRET_ENV] = canonical.secret()
    process.env[DEPRECATED_FUNDING_SECRET_ENV] = Keypair.random().secret()

    expect(getFundingWalletPublicKey()).toBe(canonical.publicKey())
  })

  it('derives the public key from the deprecated alias when it is the only name', () => {
    const legacy = Keypair.random()
    delete process.env[FUNDING_SECRET_ENV]
    process.env[DEPRECATED_FUNDING_SECRET_ENV] = legacy.secret()

    expect(getFundingWalletPublicKey()).toBe(legacy.publicKey())
  })

  it('throws with the canonical name when neither variable is set', () => {
    delete process.env[FUNDING_SECRET_ENV]
    delete process.env[DEPRECATED_FUNDING_SECRET_ENV]

    expect(() => getFundingWalletPublicKey()).toThrow(FUNDING_SECRET_ENV)
  })

  it('rejects an invalid secret from either name', () => {
    delete process.env[FUNDING_SECRET_ENV]
    process.env[DEPRECATED_FUNDING_SECRET_ENV] = 'not-a-secret'

    expect(() => getFundingWalletPublicKey()).toThrow('Invalid')
  })
})

describe('trustline bootstrap sponsor resolution (#1911)', () => {
  it('uses the shared funding accessor when no dedicated sponsor is configured', async () => {
    const funding = Keypair.random()
    process.env[FUNDING_SECRET_ENV] = funding.secret()
    delete process.env[DEPRECATED_FUNDING_SECRET_ENV]
    delete process.env.STELLAR_SPONSOR_SECRET

    const { resolveSponsorKeypair } = await import(
      '@/app/api/stellar/trustlines/usdc/bootstrap/route'
    )
    expect(resolveSponsorKeypair().publicKey()).toBe(funding.publicKey())
  })

  it('uses the dedicated sponsor secret when configured', async () => {
    const sponsor = Keypair.random()
    process.env.STELLAR_SPONSOR_SECRET = sponsor.secret()
    process.env[FUNDING_SECRET_ENV] = Keypair.random().secret()

    const { resolveSponsorKeypair } = await import(
      '@/app/api/stellar/trustlines/usdc/bootstrap/route'
    )
    expect(resolveSponsorKeypair().publicKey()).toBe(sponsor.publicKey())
  })
})
