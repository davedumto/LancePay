import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceFindUnique = vi.fn()
const invoiceUpdate = vi.fn()
const generateText = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('ai', () => ({ generateText }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: { findUnique: invoiceFindUnique, update: invoiceUpdate },
  },
}))
vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn(),
}))

const BASE_URL = 'http://localhost/api/routes-b/invoices/inv_1/ai-draft'
const PARAMS = { params: Promise.resolve({ id: 'inv_1' }) }

function makeRequest(body: unknown, authHeader = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: authHeader
      ? { 'content-type': 'application/json', authorization: authHeader }
      : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/routes-b/invoices/[id]/ai-draft', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when unauthorized', async () => {
    const { POST } = await import('@/app/api/routes-b/invoices/[id]/ai-draft/route')
    const res = await POST(makeRequest({ prompt: 'Design logo' }, ''), PARAMS)
    expect(res.status).toBe(401)
  })

  it('returns 400 when prompt is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_1', userId: 'user_1', status: 'pending' })

    const { POST } = await import('@/app/api/routes-b/invoices/[id]/ai-draft/route')
    const res = await POST(makeRequest({}), PARAMS)
    expect(res.status).toBe(400)
  })

  it('returns 422 when invoice is not pending', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_1', userId: 'user_1', status: 'paid' })

    const { POST } = await import('@/app/api/routes-b/invoices/[id]/ai-draft/route')
    const res = await POST(makeRequest({ prompt: 'Design logo' }), PARAMS)
    expect(res.status).toBe(422)
  })

  it('generates text via AI SDK and updates invoice description', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_1', userId: 'user_1', status: 'pending' })
    generateText.mockResolvedValue({ text: 'Professional Logo Design Services' })
    invoiceUpdate.mockResolvedValue({
      id: 'inv_1',
      invoiceNumber: 'INV-001',
      description: 'Professional Logo Design Services',
      amount: 150.0,
      status: 'pending',
      updatedAt: new Date(),
    })

    const { POST } = await import('@/app/api/routes-b/invoices/[id]/ai-draft/route')
    const res = await POST(makeRequest({ prompt: 'Design logo' }), PARAMS)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.invoice.description).toBe('Professional Logo Design Services')
    expect(generateText).toHaveBeenCalled()
    expect(invoiceUpdate).toHaveBeenCalledWith({
      where: { id: 'inv_1' },
      data: { description: 'Professional Logo Design Services' },
      select: expect.any(Object),
    })
  })
})
