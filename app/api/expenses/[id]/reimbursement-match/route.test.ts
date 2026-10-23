import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GET, POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    expense: { findFirst: vi.fn() },
    expenseReimbursementMatch: { create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUserId = 'user-123'
const mockPrivyId = 'privy-123'
const mockExpenseId = 'expense-123'
const mockInvoiceId = 'invoice-123'
const params = { id: mockExpenseId }

function makeRequest(method: 'GET' | 'POST', body?: Record<string, unknown>) {
  return new NextRequest(`http://localhost:3000/api/expenses/${mockExpenseId}/reimbursement-match`, {
    method,
    headers: { Authorization: 'Bearer valid-token' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: mockPrivyId } as { userId: string })
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: mockUserId } as never)
})

describe('GET /api/expenses/[id]/reimbursement-match', () => {
  it('returns the reimbursement match for the authenticated owner', async () => {
    const mockExpense = {
      id: mockExpenseId,
      category: 'Software',
      description: 'Development tools',
      amount: 100,
      currency: 'USD',
      expenseDate: new Date(),
      reimbursementMatch: {
        id: 'match-1',
        expenseId: mockExpenseId,
        invoiceId: mockInvoiceId,
        createdAt: new Date(),
        invoice: {
          id: mockInvoiceId,
          invoiceNumber: 'INV-001',
          clientEmail: 'client@example.com',
          amount: 1000,
          currency: 'USD',
          status: 'pending',
        },
      },
    }
    vi.mocked(prisma.expense.findFirst).mockResolvedValue(mockExpense as never)

    const res = await GET(makeRequest('GET'), { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.match.id).toBe('match-1')
    expect(data.expense.id).toBe(mockExpenseId)
    expect(data.invoice.id).toBe(mockInvoiceId)
  })

  it('returns 404 when no reimbursement match exists', async () => {
    const mockExpense = {
      id: mockExpenseId,
      category: 'Software',
      description: 'Development tools',
      amount: 100,
      currency: 'USD',
      expenseDate: new Date(),
      reimbursementMatch: null,
    }
    vi.mocked(prisma.expense.findFirst).mockResolvedValue(mockExpense as never)

    const res = await GET(makeRequest('GET'), { params })
    expect(res.status).toBe(404)
  })

  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest(`http://localhost:3000/api/expenses/${mockExpenseId}/reimbursement-match`)
    const res = await GET(request, { params })
    expect(res.status).toBe(401)
  })

  it('returns 404 when expense does not exist', async () => {
    vi.mocked(prisma.expense.findFirst).mockResolvedValue(null)
    const res = await GET(makeRequest('GET'), { params })
    expect(res.status).toBe(404)
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.expense.findFirst).mockRejectedValue(new Error('Database error'))
    const res = await GET(makeRequest('GET'), { params })
    expect(res.status).toBe(500)
  })
})

describe('POST /api/expenses/[id]/reimbursement-match', () => {
  it('creates a reimbursement match linking expense to invoice', async () => {
    const mockExpense = {
      id: mockExpenseId,
      category: 'Software',
      description: 'Development tools',
      amount: 100,
      currency: 'USD',
      expenseDate: new Date(),
      reimbursementMatch: null,
    }
    vi.mocked(prisma.expense.findFirst).mockResolvedValue(mockExpense as never)

    vi.mocked(prisma.invoice.findFirst).mockResolvedValue({
      id: mockInvoiceId,
      invoiceNumber: 'INV-001',
      clientEmail: 'client@example.com',
      amount: 1000,
      currency: 'USD',
      status: 'pending',
    } as never)

    const mockMatch = {
      id: 'match-1',
      expenseId: mockExpenseId,
      invoiceId: mockInvoiceId,
      createdAt: new Date(),
    }
    vi.mocked(prisma.expenseReimbursementMatch.create).mockResolvedValue(mockMatch as never)

    const res = await POST(makeRequest('POST', { invoiceId: mockInvoiceId }), { params })
    const data = await res.json()

    expect(res.status).toBe(201)
    expect(data.match.id).toBe('match-1')
    expect(data.expense.id).toBe(mockExpenseId)
    expect(data.invoice.id).toBe(mockInvoiceId)
    expect(prisma.expenseReimbursementMatch.create).toHaveBeenCalledWith({
      data: {
        expenseId: mockExpenseId,
        invoiceId: mockInvoiceId,
      },
    })
  })

  it('returns 409 when expense is already matched', async () => {
    const mockExpense = {
      id: mockExpenseId,
      category: 'Software',
      description: 'Development tools',
      amount: 100,
      currency: 'USD',
      expenseDate: new Date(),
      reimbursementMatch: {
        id: 'existing-match',
        expenseId: mockExpenseId,
        invoiceId: 'other-invoice',
        createdAt: new Date(),
      },
    }
    vi.mocked(prisma.expense.findFirst).mockResolvedValue(mockExpense as never)

    const res = await POST(makeRequest('POST', { invoiceId: mockInvoiceId }), { params })
    expect(res.status).toBe(409)
  })

  it('returns 404 when invoice does not exist', async () => {
    const mockExpense = {
      id: mockExpenseId,
      category: 'Software',
      description: 'Development tools',
      amount: 100,
      currency: 'USD',
      expenseDate: new Date(),
      reimbursementMatch: null,
    }
    vi.mocked(prisma.expense.findFirst).mockResolvedValueOnce(mockExpense as never)
    vi.mocked(prisma.expense.findFirst).mockResolvedValueOnce(null as never)

    const res = await POST(makeRequest('POST', { invoiceId: mockInvoiceId }), { params })
    expect(res.status).toBe(404)
  })

  it('validates expense and invoice belong to the same user', async () => {
    const mockExpense = {
      id: mockExpenseId,
      category: 'Software',
      description: 'Development tools',
      amount: 100,
      currency: 'USD',
      expenseDate: new Date(),
      reimbursementMatch: null,
    }
    vi.mocked(prisma.expense.findFirst).mockResolvedValue(mockExpense as never)

    const mockMatch = {
      id: 'match-1',
      expenseId: mockExpenseId,
      invoiceId: mockInvoiceId,
      createdAt: new Date(),
    }
    vi.mocked(prisma.expenseReimbursementMatch.create).mockResolvedValue(mockMatch as never)

    await POST(makeRequest('POST', { invoiceId: mockInvoiceId }), { params })

    expect(prisma.expense.findFirst).toHaveBeenCalledWith({
      where: { id: mockExpenseId, userId: mockUserId },
      include: { reimbursementMatch: true },
    })
  })

  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest(`http://localhost:3000/api/expenses/${mockExpenseId}/reimbursement-match`, {
      method: 'POST',
      body: JSON.stringify({ invoiceId: mockInvoiceId }),
    })
    const res = await POST(request, { params })
    expect(res.status).toBe(401)
  })

  it('returns 400 when invoiceId is missing', async () => {
    const res = await POST(makeRequest('POST', {}), { params })
    expect(res.status).toBe(400)
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.expense.findFirst).mockRejectedValue(new Error('Database error'))
    const res = await POST(makeRequest('POST', { invoiceId: mockInvoiceId }), { params })
    expect(res.status).toBe(500)
  })
})
