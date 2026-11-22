/**
 * Shared constants and helpers for Stellar Claimable Balances.
 *
 * Implements standard error-code mapping and route constants for the
 * planned /api/stellar/claimable-balances endpoints.
 */

export const OP_NO_TRUST_ERROR_MESSAGE =
  'Recipient must add USDC trustline before claiming. Please add a USDC trustline to your account first.'

export const CLAIMABLE_BALANCE_PLANNED_ROUTES = {
  base: '/api/stellar/claimable-balances',
  claim: '/api/stellar/claimable-balances/claim',
  create: '/api/stellar/claimable-balances/create',
} as const

/**
 * Detects whether an error, Horizon response, or error string indicates an `op_no_trust` condition.
 */
export function isOpNoTrustError(error: unknown): boolean {
  if (!error) return false

  if (typeof error === 'string') {
    return error.toLowerCase().includes('op_no_trust')
  }

  if (typeof error === 'object') {
    const errObj = error as Record<string, unknown>

    if (errObj.code === 'op_no_trust' || errObj.opCode === 'op_no_trust') {
      return true
    }

    if (typeof errObj.message === 'string' && errObj.message.toLowerCase().includes('op_no_trust')) {
      return true
    }

    // Inspect Horizon error extras: { extras: { result_codes: { operations: ['op_no_trust'] } } }
    const response = errObj.response as Record<string, unknown> | undefined
    const data = (response?.data ?? errObj.data) as Record<string, unknown> | undefined
    const extras = data?.extras as Record<string, unknown> | undefined
    const resultCodes = (extras?.result_codes ?? errObj.result_codes) as Record<string, unknown> | undefined

    if (resultCodes) {
      if (Array.isArray(resultCodes.operations) && resultCodes.operations.includes('op_no_trust')) {
        return true
      }
    }
  }

  return false
}

/**
 * Maps claimable balance operation errors to user-friendly messages.
 * Maps `op_no_trust` to OP_NO_TRUST_ERROR_MESSAGE.
 */
export function mapClaimableBalanceError(error: unknown): string {
  if (isOpNoTrustError(error)) {
    return OP_NO_TRUST_ERROR_MESSAGE
  }

  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  return 'Failed to claim balance'
}
