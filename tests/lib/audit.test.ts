import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'

const createMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  prisma: {
    auditEvent: { create: createMock },
  },
}))

import { generateSignature, logAuditEvent, verifySignature } from '@/lib/audit'

describe('lib/audit verifySignature helper (#1521)', () => {
  const invoiceId = 'inv_123'
  const eventType = 'invoice.created'
  const timestamp = '2026-09-26T10:00:00.000Z'
  const metadata = { ip: '127.0.0.1', userAgent: 'test-agent' }

  it('returns true when signature matches expected HMAC exactly', () => {
    const validSignature = generateSignature(invoiceId, eventType, timestamp, metadata)
    expect(verifySignature(invoiceId, eventType, timestamp, metadata, validSignature)).toBe(true)
  })

  it('returns false when signature has an altered character', () => {
    const validSignature = generateSignature(invoiceId, eventType, timestamp, metadata)
    const altered = validSignature.slice(0, -1) + (validSignature.slice(-1) === 'a' ? 'b' : 'a')
    expect(verifySignature(invoiceId, eventType, timestamp, metadata, altered)).toBe(false)
  })

  it('returns false when signature is shorter than expected without throwing', () => {
    const validSignature = generateSignature(invoiceId, eventType, timestamp, metadata)
    const shortSig = validSignature.slice(0, 10)
    expect(verifySignature(invoiceId, eventType, timestamp, metadata, shortSig)).toBe(false)
  })

  it('returns false when signature is longer than expected without throwing', () => {
    const validSignature = generateSignature(invoiceId, eventType, timestamp, metadata)
    const longSig = validSignature + 'extra_bytes'
    expect(verifySignature(invoiceId, eventType, timestamp, metadata, longSig)).toBe(false)
  })

  it('returns false when signature is empty string or non-string', () => {
    expect(verifySignature(invoiceId, eventType, timestamp, metadata, '')).toBe(false)
    expect(verifySignature(invoiceId, eventType, timestamp, metadata, null as unknown as string)).toBe(false)
    expect(verifySignature(invoiceId, eventType, timestamp, metadata, undefined as unknown as string)).toBe(false)
  })

  it('uses crypto.timingSafeEqual for equal length comparison to prevent timing leak', () => {
    const timingSpy = vi.spyOn(crypto, 'timingSafeEqual')
    const validSignature = generateSignature(invoiceId, eventType, timestamp, metadata)
    
    // Create a fake signature of the exact same length with prefix match
    const fakeSignature = validSignature.slice(0, 16) + '0'.repeat(validSignature.length - 16)
    
    const result = verifySignature(invoiceId, eventType, timestamp, metadata, fakeSignature)
    expect(result).toBe(false)
    expect(timingSpy).toHaveBeenCalled()

    timingSpy.mockRestore()
  })

  it('handles null metadata consistently between generate and verify', () => {
    const sig = generateSignature(invoiceId, eventType, timestamp, null)
    expect(verifySignature(invoiceId, eventType, timestamp, null, sig)).toBe(true)
    expect(verifySignature(invoiceId, eventType, timestamp, { different: true }, sig)).toBe(false)
  })
})

describe('lib/audit logAuditEvent signature persistence (#1833)', () => {
  beforeEach(() => {
    createMock.mockReset()
    // Simulate prisma returning the created row, including the explicit
    // createdAt that was signed.
    createMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'evt_1',
      ...data,
    }))
  })

  it('persists the signed timestamp as createdAt so the signature verifies', async () => {
    const metadata = { ip: '10.0.0.1', userAgent: 'vitest' }
    const row = await logAuditEvent('inv_1', 'invoice.paid', 'user_1', metadata)

    expect(createMock).toHaveBeenCalledTimes(1)
    const storedTimestamp = (row.createdAt as Date).toISOString()

    expect(
      verifySignature('inv_1', 'invoice.paid', storedTimestamp, metadata, row.signature as string)
    ).toBe(true)
  })

  it('verifies regardless of metadata key order', async () => {
    const row = await logAuditEvent('inv_2', 'invoice.created', null, {
      zebra: 1,
      alpha: { nested: true, a: 1 },
    })

    const reordered = { alpha: { a: 1, nested: true }, zebra: 1 }
    expect(
      verifySignature(
        'inv_2',
        'invoice.created',
        (row.createdAt as Date).toISOString(),
        reordered,
        row.signature as string
      )
    ).toBe(true)
  })

  it('fails verification when the timestamp or metadata is altered', async () => {
    const row = await logAuditEvent('inv_3', 'invoice.paid', 'user_1', { ip: '10.0.0.1' })
    const ts = (row.createdAt as Date).toISOString()

    expect(
      verifySignature('inv_3', 'invoice.paid', new Date(Date.now() + 1000).toISOString(), { ip: '10.0.0.1' }, row.signature as string)
    ).toBe(false)
    expect(
      verifySignature('inv_3', 'invoice.paid', ts, { ip: '10.0.0.2' }, row.signature as string)
    ).toBe(false)
  })
})
