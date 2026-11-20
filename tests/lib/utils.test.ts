import { describe, it, expect, vi } from 'vitest'
import {
  generateInvoiceNumber,
  isInvoiceNumberCollision,
  withInvoiceNumberRetry,
  INVOICE_NUMBER_MAX_ATTEMPTS,
} from '@/lib/utils'

function p2002(target?: unknown) {
  return {
    code: 'P2002',
    meta: target === undefined ? {} : { target },
    message: 'Unique constraint failed',
  }
}

describe('generateInvoiceNumber', () => {
  it('returns the documented INV-<timestamp>-<random> format', () => {
    const invoiceNumber = generateInvoiceNumber()
    expect(invoiceNumber).toMatch(/^INV-[A-Z0-9]+-[0-9A-F]{8}$/)
  })

  it('produces unique values across calls', () => {
    const numbers = new Set(
      Array.from({ length: 200 }, () => generateInvoiceNumber()),
    )
    expect(numbers.size).toBe(200)
  })
})

describe('isInvoiceNumberCollision', () => {
  it('detects P2002 on the invoiceNumber field', () => {
    expect(isInvoiceNumberCollision(p2002(['invoiceNumber']))).toBe(true)
    expect(isInvoiceNumberCollision(p2002('invoiceNumber'))).toBe(true)
    expect(isInvoiceNumberCollision(p2002(['invoiceNumber', 'id']))).toBe(true)
  })

  it('treats P2002 without usable target metadata as a collision', () => {
    expect(isInvoiceNumberCollision(p2002())).toBe(true)
    expect(isInvoiceNumberCollision({ code: 'P2002' })).toBe(true)
  })

  it('rejects P2002 on other fields and non-Prisma errors', () => {
    expect(isInvoiceNumberCollision(p2002(['id']))).toBe(false)
    expect(isInvoiceNumberCollision(p2002('id'))).toBe(false)
    expect(isInvoiceNumberCollision(new Error('boom'))).toBe(false)
    expect(isInvoiceNumberCollision('P2002')).toBe(false)
    expect(isInvoiceNumberCollision(null)).toBe(false)
  })
})

describe('withInvoiceNumberRetry', () => {
  it('returns the created record on the first attempt', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'inv-1' })
    const result = await withInvoiceNumberRetry(create)
    expect(result).toEqual({ id: 'inv-1' })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0]).toMatch(/^INV-/)
  })

  it('retries with a fresh number after an invoiceNumber collision', async () => {
    const numbers: string[] = []
    const create = vi
      .fn()
      .mockImplementationOnce(() => {
        throw p2002(['invoiceNumber'])
      })
      .mockImplementationOnce((n: string) => {
        numbers.push(n)
        return Promise.resolve({ id: 'inv-2', invoiceNumber: n })
      })

    const result = await withInvoiceNumberRetry(create)

    expect(result).toMatchObject({ id: 'inv-2' })
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('does not retry non-collision errors', async () => {
    const create = vi.fn().mockRejectedValue(new Error('db down'))
    await expect(withInvoiceNumberRetry(create)).rejects.toThrow('db down')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('gives up after the bounded number of attempts', async () => {
    const create = vi.fn().mockRejectedValue(p2002(['invoiceNumber']))
    await expect(withInvoiceNumberRetry(create, 3)).rejects.toMatchObject({
      code: 'P2002',
    })
    expect(create).toHaveBeenCalledTimes(3)
    expect(INVOICE_NUMBER_MAX_ATTEMPTS).toBeGreaterThan(0)
  })
})
