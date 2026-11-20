import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { envNumber } from '@/lib/env'

const ENV_NAME = 'TEST_NUMERIC_ENV'

describe('envNumber', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env[ENV_NAME]
  })

  it('returns the fallback when the variable is unset', () => {
    expect(envNumber(ENV_NAME, 42)).toBe(42)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('returns the fallback when the variable is empty', () => {
    process.env[ENV_NAME] = ''
    process.env[ENV_NAME] = '   '
    expect(envNumber(ENV_NAME, 42)).toBe(42)
    expect(envNumber(ENV_NAME, 42)).toBe(42)
  })

  it('accepts a valid integer', () => {
    process.env[ENV_NAME] = '432000000'
    expect(envNumber(ENV_NAME, 42, { integer: true })).toBe(432000000)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('accepts a valid decimal when integer is not required', () => {
    process.env[ENV_NAME] = '0.8'
    expect(envNumber(ENV_NAME, 42)).toBe(0.8)
  })

  it('rejects non-numeric input like "5d" and warns', () => {
    process.env[ENV_NAME] = '5d'
    expect(envNumber(ENV_NAME, 42)).toBe(42)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(ENV_NAME),
    )
  })

  it('rejects negative values', () => {
    process.env[ENV_NAME] = '-5'
    expect(envNumber(ENV_NAME, 42)).toBe(42)
    expect(console.warn).toHaveBeenCalled()
  })

  it('rejects zero unless allowZero is set', () => {
    process.env[ENV_NAME] = '0'
    expect(envNumber(ENV_NAME, 42)).toBe(42)
    expect(envNumber(ENV_NAME, 42, { allowZero: true })).toBe(0)
  })

  it('rejects non-integers when integer is required', () => {
    process.env[ENV_NAME] = '1.5'
    expect(envNumber(ENV_NAME, 42, { integer: true })).toBe(42)
    expect(envNumber(ENV_NAME, 42)).toBe(1.5)
  })

  it('rejects NaN and Infinity', () => {
    for (const bad of ['NaN', 'Infinity', '-Infinity']) {
      process.env[ENV_NAME] = bad
      expect(envNumber(ENV_NAME, 42)).toBe(42)
    }
  })
})

describe('KYC_REVIEW_SLA_WINDOW_MS validation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.KYC_REVIEW_SLA_WINDOW_MS
    vi.resetModules()
  })

  async function loadConfig() {
    vi.resetModules()
    return import('@/lib/kyc-config')
  }

  it('uses the five-day default for invalid values instead of NaN', async () => {
    for (const bad of ['', '5d', '-1', 'abc']) {
      process.env.KYC_REVIEW_SLA_WINDOW_MS = bad
      const { KYC_REVIEW_SLA_WINDOW_MS, getKycSlaDeadline } = await loadConfig()
      expect(KYC_REVIEW_SLA_WINDOW_MS).toBe(5 * 24 * 60 * 60 * 1000)
      expect(Number.isFinite(getKycSlaDeadline(new Date()))).toBe(true)
    }
  })

  it('accepts a valid override', async () => {
    process.env.KYC_REVIEW_SLA_WINDOW_MS = '86400000'
    const { KYC_REVIEW_SLA_WINDOW_MS, getTimeRemainingMs } = await loadConfig()
    expect(KYC_REVIEW_SLA_WINDOW_MS).toBe(86400000)
    expect(getTimeRemainingMs(new Date(0), 0)).toBe(86400000)
  })
})
