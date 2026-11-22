import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isKycRateLimitBypassed, getKycBypassIds } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

describe('KYC Rate Limit Bypass Security & Audit Logging (#1902)', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(logger, 'warn').mockImplementation((() => {}) as any)
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.restoreAllMocks()
  })

  describe('Development / Test Environment', () => {
    it('allows configured bypass IDs and logs structured warning', () => {
      process.env.NODE_ENV = 'development'
      process.env.KYC_RATE_LIMIT_BYPASS_IDS = 'bypass-user-1, bypass-user-2'

      const isBypassed = isKycRateLimitBypassed('bypass-user-1', 'kyc-submit-hourly')
      expect(isBypassed).toBe(true)

      expect(logger.warn).toHaveBeenCalledWith(
        {
          userId: 'bypass-user-1',
          limiterId: 'kyc-submit-hourly',
          event: 'kyc_rate_limit_bypass',
        },
        'KYC rate limit bypass applied for user'
      )
    })

    it('rejects unconfigured users without logging', () => {
      process.env.NODE_ENV = 'development'
      process.env.KYC_RATE_LIMIT_BYPASS_IDS = 'bypass-user-1'

      const isBypassed = isKycRateLimitBypassed('normal-user', 'kyc-submit')
      expect(isBypassed).toBe(false)
      expect(logger.warn).not.toHaveBeenCalled()
    })

    it('updates dynamically when environment variable changes', () => {
      process.env.NODE_ENV = 'development'
      process.env.KYC_RATE_LIMIT_BYPASS_IDS = 'user-initial'
      expect(isKycRateLimitBypassed('user-initial')).toBe(true)
      expect(isKycRateLimitBypassed('user-later')).toBe(false)

      process.env.KYC_RATE_LIMIT_BYPASS_IDS = 'user-later'
      expect(isKycRateLimitBypassed('user-initial')).toBe(false)
      expect(isKycRateLimitBypassed('user-later')).toBe(true)
    })
  })

  describe('Production Environment without Allow Flag', () => {
    it('strictly refuses to load bypass IDs when NODE_ENV is production and allow flag is not set', () => {
      process.env.NODE_ENV = 'production'
      delete process.env.ALLOW_KYC_RATE_LIMIT_BYPASS
      delete process.env.ALLOW_KYC_RATE_LIMIT_BYPASS_IN_PRODUCTION
      process.env.KYC_RATE_LIMIT_BYPASS_IDS = 'leak-user-1,leak-user-2'

      expect(getKycBypassIds().size).toBe(0)
      expect(isKycRateLimitBypassed('leak-user-1', 'kyc-status')).toBe(false)
      expect(logger.warn).not.toHaveBeenCalled()
    })

    it('refuses bypass in production when allow flag is explicitly false', () => {
      process.env.NODE_ENV = 'production'
      process.env.ALLOW_KYC_RATE_LIMIT_BYPASS = 'false'
      process.env.KYC_RATE_LIMIT_BYPASS_IDS = 'leak-user-1'

      expect(isKycRateLimitBypassed('leak-user-1')).toBe(false)
      expect(logger.warn).not.toHaveBeenCalled()
    })
  })

  describe('Production Environment with Explicit Allow Flag', () => {
    it('permits bypass IDs only when ALLOW_KYC_RATE_LIMIT_BYPASS is explicitly true', () => {
      process.env.NODE_ENV = 'production'
      process.env.ALLOW_KYC_RATE_LIMIT_BYPASS = 'true'
      process.env.KYC_RATE_LIMIT_BYPASS_IDS = 'authorized-prod-tester'

      expect(getKycBypassIds().has('authorized-prod-tester')).toBe(true)
      const isBypassed = isKycRateLimitBypassed('authorized-prod-tester', 'kyc-submit-daily')
      expect(isBypassed).toBe(true)

      expect(logger.warn).toHaveBeenCalledWith(
        {
          userId: 'authorized-prod-tester',
          limiterId: 'kyc-submit-daily',
          event: 'kyc_rate_limit_bypass',
        },
        'KYC rate limit bypass applied for user'
      )
    })
  })
})
