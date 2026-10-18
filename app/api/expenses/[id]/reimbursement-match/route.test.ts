import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockPrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  expense: {
    findUnique: vi.fn(),
  },
  invoice: {
    findUnique: vi.fn(),
  },
  expenseReimbursementMatch: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
}))

const mockVerifyAuthToken = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { GET, POST } from './route'

describe('GET, POST /api/expenses/[id]/reimbursement-match', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'did:privy:user_exp_1' })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user_exp_1' })
    mockPrisma.expenseReimbursementMatch.findUnique.mockResolvedValue(null)
  })

  it('returns the match along with both the expense and invoice summary on POST and GET', async () => {
    mockPrisma.expense.findUnique.mockResolvedValue({
      id: 'exp_100',
      userId: 'user_exp_1',
      category: 'software',
      description: 'Figma team seat license',
      amount: '45.000000',
      currency: 'USDC',
      expenseDate: new Date('2026-06-01T00:00:00.000Z'),
      reimbursementMatch: null,
    })

    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: 'inv_200',
      userId: 'user_exp_1',
      invoiceNumber: 'INV-2026-042',
      clientName: 'Acme Design Corp',
      clientEmail: 'billing@acme.com',
      amount: '1545.00',
      currency: 'USDC',
      status: 'pending',
    })

    mockPrisma.expenseReimbursementMatch.create.mockResolvedValue({
      id: 'match_1',
      expenseId: 'exp_100',
      invoiceId: 'inv_200',
      createdAt: new Date('2026-06-05T10:00:00.000Z'),
    })

    const postReq = new NextRequest(
      'http://localhost/api/expenses/exp_100/reimbursement-match',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ invoiceId: 'inv_200' }),
      },
    )

    const postRes = await POST(postReq, { params: { id: 'exp_100' } })
    expect(postRes.status).toBe(201)
    const postBody = await postRes.json()

    expect(postBody.match).toMatchObject({
      id: 'match_1',
      expenseId: 'exp_100',
      invoiceId: 'inv_200',
    })
    expect(postBody.expense).toMatchObject({
      id: 'exp_100',
      userId: 'user_exp_1',
      category: 'software',
      description: 'Figma team seat license',
      amount: '45.000000',
      currency: 'USDC',
    })
    expect(postBody.invoice).toMatchObject({
      id: 'inv_200',
      userId: 'user_exp_1',
      invoiceNumber: 'INV-2026-042',
      clientName: 'Acme Design Corp',
      amount: '1545.00',
    })

    // GET also returns match + expense + invoice summary
    mockPrisma.expense.findUnique.mockResolvedValueOnce({
      id: 'exp_100',
      userId: 'user_exp_1',
      category: 'software',
      description: 'Figma team seat license',
      amount: '45.000000',
      currency: 'USDC',
      expenseDate: new Date('2026-06-01T00:00:00.000Z'),
      reimbursementMatch: {
        id: 'match_1',
        expenseId: 'exp_100',
        invoiceId: 'inv_200',
        createdAt: new Date('2026-06-05T10:00:00.000Z'),
        invoice: {
          id: 'inv_200',
          userId: 'user_exp_1',
          invoiceNumber: 'INV-2026-042',
          clientName: 'Acme Design Corp',
          clientEmail: 'billing@acme.com',
          amount: '1545.00',
          currency: 'USDC',
          status: 'pending',
        },
      },
    })

    const getReq = new NextRequest(
      'http://localhost/api/expenses/exp_100/reimbursement-match',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const getRes = await GET(getReq, { params: { id: 'exp_100' } })
    expect(getRes.status).toBe(200)
    const getBody = await getRes.json()
    expect(getBody.match.id).toBe('match_1')
    expect(getBody.expense.id).toBe('exp_100')
    expect(getBody.invoice.id).toBe('inv_200')
  })

  it('enforces the unique expenseId constraint and rejects a second match attempt with 409', async () => {
    mockPrisma.expense.findUnique.mockResolvedValue({
      id: 'exp_100',
      userId: 'user_exp_1',
      category: 'travel',
      description: 'Client flight ticket',
      amount: '320.000000',
      currency: 'USDC',
      reimbursementMatch: {
        id: 'match_existing',
        expenseId: 'exp_100',
        invoiceId: 'inv_200',
      },
    })

    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: 'inv_300',
      userId: 'user_exp_1',
      amount: '500.00',
      currency: 'USDC',
      status: 'pending',
    })

    const dupReq = new NextRequest(
      'http://localhost/api/expenses/exp_100/reimbursement-match',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ invoiceId: 'inv_300' }),
      },
    )

    const dupRes = await POST(dupReq, { params: { id: 'exp_100' } })
    expect(dupRes.status).toBe(409)
    const dupBody = await dupRes.json()
    expect(dupBody.code).toBe('EXPENSE_ALREADY_MATCHED')
    expect(dupBody.existingInvoiceId).toBe('inv_200')
    expect(
      mockPrisma.expenseReimbursementMatch.create,
    ).not.toHaveBeenCalled()
  })

  it('validates that the expense and invoice belong to the same user', async () => {
    mockPrisma.expense.findUnique.mockResolvedValue({
      id: 'exp_100',
      userId: 'user_exp_1',
      category: 'hosting',
      description: 'Cloud GPU usage',
      amount: '120.000000',
      currency: 'USDC',
      reimbursementMatch: null,
    })

    // Invoice belongs to a different user
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: 'inv_other_user',
      userId: 'other_user_99',
      amount: '120.00',
      currency: 'USDC',
      status: 'pending',
    })

    const mismatchReq = new NextRequest(
      'http://localhost/api/expenses/exp_100/reimbursement-match',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ invoiceId: 'inv_other_user' }),
      },
    )

    const mismatchRes = await POST(mismatchReq, { params: { id: 'exp_100' } })
    expect(mismatchRes.status).toBe(403)
    const mismatchBody = await mismatchRes.json()
    expect(mismatchBody.code).toBe('EXPENSE_INVOICE_USER_MISMATCH')
    expect(
      mockPrisma.expenseReimbursementMatch.create,
    ).not.toHaveBeenCalled()
  })
})
