import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Keypair, Account } from '@stellar/stellar-sdk'

const {
  mockLoadAccount,
  mockFetchBaseFee,
  mockSubmitTransaction,
  mockTransactions,
} = vi.hoisted(() => ({
  mockLoadAccount: vi.fn(),
  mockFetchBaseFee: vi.fn(),
  mockSubmitTransaction: vi.fn(),
  mockTransactions: vi.fn(),
}))

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>()
  class MockServer {
    loadAccount = mockLoadAccount
    fetchBaseFee = mockFetchBaseFee
    submitTransaction = mockSubmitTransaction
    transactions = mockTransactions
  }
  return {
    ...actual,
    Horizon: { ...actual.Horizon, Server: MockServer },
  }
})

import {
  sendUSDCPayment,
  debitDelegatedUSDC,
  submitMultisigPaymentWithRetry,
  sanitizeStellarTextMemo,
  StellarOperationError,
} from '@/lib/stellar'

const sender = Keypair.random()
const recipient = Keypair.random()

function horizonError(status: number, resultCodes?: { transaction?: string; operations?: string[] }) {
  return {
    response: {
      status,
      data: { extras: { result_codes: resultCodes } },
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockLoadAccount.mockResolvedValue(new Account(sender.publicKey(), '1'))
  mockFetchBaseFee.mockResolvedValue(100)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('sanitizeStellarTextMemo', () => {
  it('passes ASCII text through unchanged', () => {
    expect(sanitizeStellarTextMemo('invoice-123')).toEqual({
      text: 'invoice-123',
      truncated: false,
    })
  })

  it('returns null text for empty or whitespace input', () => {
    expect(sanitizeStellarTextMemo(undefined)).toEqual({ text: null, truncated: false })
    expect(sanitizeStellarTextMemo('   ')).toEqual({ text: null, truncated: false })
  })

  it('keeps multi-byte accented text within 28 UTF-8 bytes', () => {
    // 'é' is 2 UTF-8 bytes: 14 of them is exactly 28 bytes.
    const memo = 'é'.repeat(14)
    expect(sanitizeStellarTextMemo(memo)).toEqual({ text: memo, truncated: false })
  })

  it('truncates accented text on a code-point boundary', () => {
    const memo = 'é'.repeat(15) // 30 bytes
    const result = sanitizeStellarTextMemo(memo)
    expect(result.text).toBe('é'.repeat(14))
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.text!, 'utf8')).toBe(28)
  })

  it('never splits an emoji surrogate pair at the boundary', () => {
    // 24 ASCII bytes + emoji (4 UTF-8 bytes) = exactly 28 bytes.
    const fits = 'a'.repeat(24) + '😀'
    expect(sanitizeStellarTextMemo(fits)).toEqual({ text: fits, truncated: false })

    // 25 ASCII bytes + emoji would be 29 bytes: the emoji is dropped whole,
    // never leaving a lone surrogate.
    const overflow = 'a'.repeat(25) + '😀'
    const result = sanitizeStellarTextMemo(overflow)
    expect(result.text).toBe('a'.repeat(25))
    expect(result.truncated).toBe(true)
    expect(result.text).not.toMatch(/[\uD800-\uDFFF]/)
  })

  it('leaves a memo of exactly 28 UTF-8 bytes untouched', () => {
    const memo = 'x'.repeat(28)
    expect(sanitizeStellarTextMemo(memo)).toEqual({ text: memo, truncated: false })
  })
})

describe('StellarOperationError', () => {
  it('is an instanceof Error and preserves type, result codes, status and cause', async () => {
    const horizonErr = horizonError(400, {
      transaction: 'tx_bad_seq',
      operations: ['op_no_trust'],
    })
    mockSubmitTransaction.mockRejectedValue(horizonErr)

    const err = await sendUSDCPayment(
      sender.publicKey(),
      sender.secret(),
      recipient.publicKey(),
      '10',
    ).catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(StellarOperationError)
    expect(err.type).toBe('payment_failed')
    expect(err.resultCodes).toEqual({
      transaction: 'tx_bad_seq',
      operations: ['op_no_trust'],
    })
    expect(err.status).toBe(400)
    expect(err.cause).toBe(horizonErr)
    expect(typeof err.stack).toBe('string')
  })

  it('keeps the invalid_address type for validation failures', async () => {
    const err = await sendUSDCPayment(
      sender.publicKey(),
      sender.secret(),
      'not-a-valid-address',
      '10',
    ).catch((e) => e)

    expect(err).toBeInstanceOf(StellarOperationError)
    expect(err.type).toBe('invalid_address')
  })
})

describe('sendUSDCPayment submission reconciliation', () => {
  it('returns confirmed on a normal submission', async () => {
    mockSubmitTransaction.mockResolvedValue({ hash: 'confirmed-hash' })
    const result = await sendUSDCPayment(
      sender.publicKey(),
      sender.secret(),
      recipient.publicKey(),
      '10',
    )
    expect(result).toEqual({ status: 'confirmed', hash: 'confirmed-hash' })
  })

  it('confirms via hash lookup after a Horizon 504', async () => {
    mockSubmitTransaction.mockRejectedValue(horizonError(504))
    const call = vi.fn().mockResolvedValue({ transaction_successful: true })
    mockTransactions.mockReturnValue({ transaction: () => ({ call }) })

    const result = await sendUSDCPayment(
      sender.publicKey(),
      sender.secret(),
      recipient.publicKey(),
      '10',
    )

    expect(result.status).toBe('confirmed')
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(call).toHaveBeenCalled()
  })

  it('returns pending_confirmation when the hash stays unknown past the window', async () => {
    vi.useFakeTimers()
    mockSubmitTransaction.mockRejectedValue(horizonError(504))
    const call = vi.fn().mockRejectedValue(horizonError(404))
    mockTransactions.mockReturnValue({ transaction: () => ({ call }) })

    const promise = sendUSDCPayment(
      sender.publicKey(),
      sender.secret(),
      recipient.publicKey(),
      '10',
    )
    const assertion = expect(promise).resolves.toMatchObject({
      status: 'pending_confirmation',
    })

    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(2_000)
    }
    await assertion
    vi.useRealTimers()
  })

  it('throws payment_failed on a hard submission failure', async () => {
    mockSubmitTransaction.mockRejectedValue(
      horizonError(400, { operations: ['op_underfunded'] }),
    )
    const err = await sendUSDCPayment(
      sender.publicKey(),
      sender.secret(),
      recipient.publicKey(),
      '10',
    ).catch((e) => e)

    expect(err).toBeInstanceOf(StellarOperationError)
    expect(err.type).toBe('payment_failed')
  })
})

describe('debitDelegatedUSDC', () => {
  it('maps op_underfunded to insufficient_funds with preserved cause', async () => {
    const horizonErr = horizonError(400, { operations: ['op_underfunded'] })
    mockSubmitTransaction.mockRejectedValue(horizonErr)

    const err = await debitDelegatedUSDC(
      sender.secret(),
      sender.publicKey(),
      recipient.publicKey(),
      '10',
    ).catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err.type).toBe('insufficient_funds')
    expect(err.cause).toBe(horizonErr)
    expect(err.resultCodes?.operations).toEqual(['op_underfunded'])
  })
})

describe('submitMultisigPaymentWithRetry', () => {
  it('returns pending_confirmation without rebuilding while the hash is unresolved', async () => {
    vi.useFakeTimers()
    mockSubmitTransaction.mockRejectedValue(horizonError(504))
    const call = vi.fn().mockRejectedValue(horizonError(404))
    mockTransactions.mockReturnValue({ transaction: () => ({ call }) })

    const promise = submitMultisigPaymentWithRetry(
      sender.secret(),
      recipient.publicKey(),
      '10',
    )
    const assertion = expect(promise).resolves.toMatchObject({
      status: 'pending_confirmation',
    })

    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(2_000)
    }
    await assertion

    // The in-flight transaction was never rebuilt or resubmitted.
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1)
    expect(mockLoadAccount).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('still retries sequence collisions against a fresh account', async () => {
    mockSubmitTransaction
      .mockRejectedValueOnce(horizonError(400, { transaction: 'tx_bad_seq' }))
      .mockResolvedValueOnce({ hash: 'retry-hash' })

    const result = await submitMultisigPaymentWithRetry(
      sender.secret(),
      recipient.publicKey(),
      '10',
    )

    expect(result).toEqual({ status: 'confirmed', hash: 'retry-hash' })
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(2)
    expect(mockLoadAccount).toHaveBeenCalledTimes(2)
  })
})
