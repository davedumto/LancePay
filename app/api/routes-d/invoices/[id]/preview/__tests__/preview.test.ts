import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn() },
    brandingSettings: { findUnique: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFind = vi.mocked(prisma.invoice.findUnique)
const mockedBrandingFind = vi.mocked(prisma.brandingSettings.findUnique)

const INVOICE_ID = 'inv-1'
const USER_ID = 'user-1'

const fakeUser = {
  id: USER_ID,
  privyId: 'privy-1',
  name: 'Jane Freelancer',
  email: 'jane@example.com',
}

const fakeInvoice = {
  id: INVOICE_ID,
  userId: USER_ID,
  invoiceNumber: 'INV-001',
  clientName: 'Bob Client',
  clientEmail: 'bob@example.com',
  description: 'Design services',
  amount: '750.00',
  currency: 'USD',
  status: 'pending',
  dueDate: null,
  paymentLink: 'https://app/pay/INV-001',
}

const fakeBranding = {
  userId: USER_ID,
  logoUrl: 'https://cdn.example.com/logo.png',
  primaryColor: '#ff6600',
  footerText: 'Thank you for your business!',
}

function makeRequest(auth = 'Bearer token'): NextRequest {
  return new NextRequest(
    `http://localhost/api/routes-d/invoices/${INVOICE_ID}/preview`,
    {
      method: 'GET',
      headers: auth ? { authorization: auth } : {},
    },
  )
}

const params = { params: Promise.resolve({ id: INVOICE_ID }) }

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue(fakeUser as never)
  mockedInvoiceFind.mockResolvedValue(fakeInvoice as never)
  mockedBrandingFind.mockResolvedValue(fakeBranding as never)
})

describe('GET /api/routes-d/invoices/[id]/preview', () => {
  it('returns 401 when no token is supplied', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await GET(makeRequest(''), params)).status).toBe(401)
  })

  it('returns 401 when token does not verify', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await GET(makeRequest(), params)).status).toBe(401)
  })

  it('returns 404 when user cannot be resolved from claims', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    expect((await GET(makeRequest(), params)).status).toBe(404)
  })

  it('returns 404 when invoice does not exist', async () => {
    mockedInvoiceFind.mockResolvedValue(null as never)
    expect((await GET(makeRequest(), params)).status).toBe(404)
  })

  it('returns 403 when invoice belongs to another user', async () => {
    mockedInvoiceFind.mockResolvedValue({ ...fakeInvoice, userId: 'other-user' } as never)
    expect((await GET(makeRequest(), params)).status).toBe(403)
  })

  it('returns 200 with a preview object on success', async () => {
    const res = await GET(makeRequest(), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.preview).toBeDefined()
  })

  it('returns invoice fields in the preview', async () => {
    const res = await GET(makeRequest(), params)
    const { preview } = await res.json()
    expect(preview.invoice).toMatchObject({
      invoiceNumber: 'INV-001',
      clientName: 'Bob Client',
      clientEmail: 'bob@example.com',
      amount: 750,
      currency: 'USD',
      status: 'pending',
    })
  })

  it('returns branding fields in the preview', async () => {
    const res = await GET(makeRequest(), params)
    const { preview } = await res.json()
    expect(preview.branding).toMatchObject({
      logoUrl: 'https://cdn.example.com/logo.png',
      primaryColor: '#ff6600',
      footerText: 'Thank you for your business!',
    })
  })

  it('returns freelancer name and email in the preview', async () => {
    const res = await GET(makeRequest(), params)
    const { preview } = await res.json()
    expect(preview.freelancer).toMatchObject({
      name: 'Jane Freelancer',
      email: 'jane@example.com',
    })
  })

  it('returns branding defaults when no branding record exists', async () => {
    mockedBrandingFind.mockResolvedValue(null as never)
    const res = await GET(makeRequest(), params)
    const { preview } = await res.json()
    expect(preview.branding.logoUrl).toBeNull()
    expect(preview.branding.primaryColor).toBe('#6366f1')
    expect(preview.branding.footerText).toBeNull()
  })
})
