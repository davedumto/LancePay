import { describe, it, expect } from 'vitest'
import {
  OP_NO_TRUST_ERROR_MESSAGE,
  CLAIMABLE_BALANCE_PLANNED_ROUTES,
  isOpNoTrustError,
  mapClaimableBalanceError,
} from '@/lib/claimable-balances'

describe('Claimable Balances Helpers and Constants', () => {
  it('defines the exact op_no_trust error message and planned route paths', () => {
    expect(OP_NO_TRUST_ERROR_MESSAGE).toBe(
      'Recipient must add USDC trustline before claiming. Please add a USDC trustline to your account first.',
    )
    expect(CLAIMABLE_BALANCE_PLANNED_ROUTES.claim).toBe('/api/stellar/claimable-balances/claim')
    expect(CLAIMABLE_BALANCE_PLANNED_ROUTES.create).toBe('/api/stellar/claimable-balances/create')
    expect(CLAIMABLE_BALANCE_PLANNED_ROUTES.base).toBe('/api/stellar/claimable-balances')
  })

  describe('isOpNoTrustError', () => {
    it('detects op_no_trust from error string', () => {
      expect(isOpNoTrustError('Transaction failed with op_no_trust')).toBe(true)
      expect(isOpNoTrustError('op_no_trust')).toBe(true)
      expect(isOpNoTrustError('OP_NO_TRUST')).toBe(true)
    })

    it('detects op_no_trust from Error object message', () => {
      const err = new Error('Horizon error: op_no_trust')
      expect(isOpNoTrustError(err)).toBe(true)
    })

    it('detects op_no_trust from structured error code', () => {
      expect(isOpNoTrustError({ code: 'op_no_trust' })).toBe(true)
      expect(isOpNoTrustError({ opCode: 'op_no_trust' })).toBe(true)
    })

    it('detects op_no_trust from Horizon response extras structure', () => {
      const horizonErr = {
        response: {
          data: {
            extras: {
              result_codes: {
                transaction: 'tx_failed',
                operations: ['op_no_trust'],
              },
            },
          },
        },
      }
      expect(isOpNoTrustError(horizonErr)).toBe(true)
    })

    it('returns false for unrelated errors or empty input', () => {
      expect(isOpNoTrustError(null)).toBe(false)
      expect(isOpNoTrustError(undefined)).toBe(false)
      expect(isOpNoTrustError('op_underfunded')).toBe(false)
      expect(isOpNoTrustError(new Error('Network timeout'))).toBe(false)
      expect(
        isOpNoTrustError({
          response: {
            data: {
              extras: {
                result_codes: {
                  operations: ['op_bad_auth'],
                },
              },
            },
          },
        }),
      ).toBe(false)
    })
  })

  describe('mapClaimableBalanceError', () => {
    it('maps op_no_trust error to the standard human-readable guidance', () => {
      const mapped = mapClaimableBalanceError('Transaction failed with op_no_trust')
      expect(mapped).toBe(OP_NO_TRUST_ERROR_MESSAGE)
    })

    it('maps Horizon structured op_no_trust error to OP_NO_TRUST_ERROR_MESSAGE', () => {
      const errorObj = {
        response: {
          data: {
            extras: {
              result_codes: {
                operations: ['op_no_trust'],
              },
            },
          },
        },
      }
      expect(mapClaimableBalanceError(errorObj)).toBe(OP_NO_TRUST_ERROR_MESSAGE)
    })

    it('preserves generic Error messages when not op_no_trust', () => {
      expect(mapClaimableBalanceError(new Error('Network connection dropped'))).toBe(
        'Network connection dropped',
      )
    })

    it('returns fallback message for unknown non-string objects', () => {
      expect(mapClaimableBalanceError({})).toBe('Failed to claim balance')
      expect(mapClaimableBalanceError(null)).toBe('Failed to claim balance')
    })
  })
})
