import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { decrypt } from '@/lib/crypto'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    wallet: {
      findUnique: vi.fn(),
    },
    virtualAccount: {
      findUnique: vi.fn(),
    },
    kycApplication: {
      findUnique: vi.fn(),
    },
    bankAccount: {
      findMany: vi.fn(),
    },
    contact: {
      findMany: vi.fn(),
    },
    invoice: {
      findMany: vi.fn(),
    },
    transaction: {
      findMany: vi.fn(),
    },
    withdrawalTransaction: {
      findMany: vi.fn(),
    },
    expense: {
      findMany: vi.fn(),
    },
    subscription: {
      findMany: vi.fn(),
    },
    timeEntry: {
      findMany: vi.fn(),
    },
    savingsGoal: {
      findMany: vi.fn(),
    },
    kycDocument: {
      findMany: vi.fn(),
    },
    notification: {
      findMany: vi.fn(),
    },
    apiKey: {
      findMany: vi.fn(),
    },
    userWebhook: {
      findMany: vi.fn(),
    },
    creditNote: {
      findMany: vi.fn(),
    },
    refund: {
      findMany: vi.fn(),
    },
    quote: {
      findMany: vi.fn(),
    },
    project: {
      findMany: vi.fn(),
    },
    fxRateSnapshot: {
      findMany: vi.fn(),
    },
    dataExportLedger: {
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
  mockVerifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { POST, getEncryptedExportFromStore } from './route'

function makePostRequest(
  userId: string,
  body: unknown,
  token: string | null = 'admin-token',
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(
    `http://localhost/api/admin/data-exports/${userId}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  )
}

describe('POST /api/admin/data-exports/[userId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({
      userId: 'admin-privy-1',
      email: 'admin@lancepay.io',
      role: 'admin',
    })
    mockPrisma.user.findUnique.mockImplementation(async ({ where }) => {
      if (where.privyId === 'admin-privy-1' || where.id === 'admin-privy-1') {
        return { id: 'admin-1', email: 'admin@lancepay.io', role: 'admin' }
      }
      if (where.id === 'user-42') {
        return {
          id: 'user-42',
          email: 'freelancer@lancepay.io',
          name: 'Ada Lovelace',
          role: 'freelancer',
          twoFactorSecret: 'SUPER_SECRET_TOTP',
          backupCodes: ['code1', 'code2'],
        }
      }
      return null
    })

    // Default empty ownership across tables unless overridden
    mockPrisma.wallet.findUnique.mockResolvedValue(null)
    mockPrisma.virtualAccount.findUnique.mockResolvedValue(null)
    mockPrisma.kycApplication.findUnique.mockResolvedValue(null)
    mockPrisma.bankAccount.findMany.mockResolvedValue([])
    mockPrisma.contact.findMany.mockResolvedValue([])
    mockPrisma.invoice.findMany.mockResolvedValue([])
    mockPrisma.transaction.findMany.mockResolvedValue([])
    mockPrisma.withdrawalTransaction.findMany.mockResolvedValue([])
    mockPrisma.expense.findMany.mockResolvedValue([])
    mockPrisma.subscription.findMany.mockResolvedValue([])
    mockPrisma.timeEntry.findMany.mockResolvedValue([])
    mockPrisma.savingsGoal.findMany.mockResolvedValue([])
    mockPrisma.kycDocument.findMany.mockResolvedValue([])
    mockPrisma.notification.findMany.mockResolvedValue([])
    mockPrisma.apiKey.findMany.mockResolvedValue([])
    mockPrisma.userWebhook.findMany.mockResolvedValue([])
    mockPrisma.creditNote.findMany.mockResolvedValue([])
    mockPrisma.refund.findMany.mockResolvedValue([])
    mockPrisma.quote.findMany.mockResolvedValue([])
    mockPrisma.project.findMany.mockResolvedValue([])
  })

  it('returns 401 when unauthenticated and 403 when caller is not an admin', async () => {
    const unauth = await POST(
      makePostRequest('user-42', { ticketReference: 'GDPR-101' }, null),
      { params: { userId: 'user-42' } },
    )
    expect(unauth.status).toBe(401)

    mockVerifyAuthToken.mockResolvedValueOnce({
      userId: 'regular-user',
      role: 'freelancer',
    })
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'regular-user',
      email: 'user@lancepay.io',
      role: 'freelancer',
    })

    const forbidden = await POST(
      makePostRequest('user-42', { ticketReference: 'GDPR-101' }),
      { params: { userId: 'user-42' } },
    )
    expect(forbidden.status).toBe(403)
  })

  it('requires a ticketReference and rejects missing ticketReference with 400', async () => {
    const res = await POST(makePostRequest('user-42', {}), {
      params: { userId: 'user-42' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('TICKET_REFERENCE_REQUIRED')
  })

  it('collects only user-owned rows, omits unowned tables, encrypts archive at rest, records ledger entry with ticketReference, and returns a short-lived download URL without archive bytes', async () => {
    mockPrisma.wallet.findUnique.mockResolvedValueOnce({
      id: 'w-1',
      userId: 'user-42',
      address: 'GABC1234567890',
    })
    mockPrisma.invoice.findMany.mockResolvedValueOnce([
      {
        id: 'inv-1',
        userId: 'user-42',
        invoiceNumber: 'INV-001',
        amount: '250.00',
      },
      {
        id: 'inv-2',
        userId: 'user-42',
        invoiceNumber: 'INV-002',
        amount: '500.00',
      },
    ])
    mockPrisma.apiKey.findMany.mockResolvedValueOnce([
      {
        id: 'ak-1',
        userId: 'user-42',
        name: 'CLI Key',
        keyHint: 'lp_live_...1234',
        hashedKey: 'SECRET_HASH_DO_NOT_EXPORT',
      },
    ])
    mockPrisma.dataExportLedger.create.mockImplementationOnce(
      async ({ data }) => ({
        ...data,
        createdAt: new Date(),
      }),
    )

    const beforeMs = Date.now()
    const res = await POST(
      makePostRequest('user-42', {
        ticketReference: 'DSAR-2026-8841',
        reason: 'Customer GDPR Art. 15 Subject Access Request',
      }),
      { params: { userId: 'user-42' } },
    )
    expect(res.status).toBe(201)
    const body = await res.json()

    // 1. Only tables where user owns rows are included; others are omitted
    expect(body.includedTables).toEqual(['wallet', 'invoices', 'apiKeys'])
    expect(body.omittedTables).toContain('bankAccounts')
    expect(body.omittedTables).toContain('expenses')
    expect(body.totalRows).toBe(4)

    // Non-user-owned global tables are never queried
    expect(mockPrisma.fxRateSnapshot.findMany).not.toHaveBeenCalled()

    // 2. Response returns a short-lived signed download URL and never leaks archive bytes/tables
    expect(body.downloadUrl).toContain(
      `/api/admin/data-exports/user-42/download?exportId=${body.exportId}`,
    )
    expect(body.downloadUrl).toContain('&sig=')
    expect(body.ttlSeconds).toBe(900)
    expect(new Date(body.expiresAt).getTime()).toBeLessThanOrEqual(
      beforeMs + 905_000,
    )
    expect(body.tables).toBeUndefined()
    expect(body.encryptedPayload).toBeUndefined()
    expect(body.archiveBytes).toBeUndefined()

    // 3. Stored archive is encrypted at rest and decrypts cleanly
    const stored = getEncryptedExportFromStore(body.exportId)
    expect(stored).toBeDefined()
    expect(stored!.encryptedPayload).not.toContain('Ada Lovelace')
    expect(stored!.encryptedPayload).toContain(':')

    const decrypted = JSON.parse(decrypt(stored!.encryptedPayload))
    expect(decrypted.userId).toBe('user-42')
    expect(decrypted.ticketReference).toBe('DSAR-2026-8841')
    expect(decrypted.profile.twoFactorSecret).toBeUndefined()
    expect(Object.keys(decrypted.tables)).toEqual([
      'wallet',
      'invoices',
      'apiKeys',
    ])
    expect(decrypted.tables.apiKeys[0].hashedKey).toBeUndefined()

    // 4. Data export ledger recorded the request with the originating ticket reference
    expect(mockPrisma.dataExportLedger.create).toHaveBeenCalledOnce()
    const ledgerArg = mockPrisma.dataExportLedger.create.mock.calls[0][0].data
    expect(ledgerArg.ticketReference).toBe('DSAR-2026-8841')
    expect(ledgerArg.userId).toBe('user-42')
    expect(ledgerArg.requestedByAdminId).toBe('admin-1')
    expect(ledgerArg.encryptedPayload).toBe(stored!.encryptedPayload)
  })
})
