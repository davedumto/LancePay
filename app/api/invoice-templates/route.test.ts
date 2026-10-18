import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockPrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  invoiceTemplate: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  invoice: {
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

describe('GET, POST /api/invoice-templates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'did:privy:user_tpl_1' })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user_tpl_1' })
    mockPrisma.invoiceTemplate.findUnique.mockResolvedValue(null)
  })

  it('enforces the unique (userId, name) constraint with a clean 409 on collision', async () => {
    mockPrisma.invoiceTemplate.create.mockResolvedValueOnce({
      id: 'tpl_1',
      userId: 'user_tpl_1',
      name: 'Monthly Retainer',
      clientEmail: 'client@acme.com',
      clientName: 'Acme Corp',
      description: 'Monthly software engineering retainer',
      amount: 3500,
      currency: 'USDC',
      createdAt: new Date('2026-06-05T10:00:00.000Z'),
      updatedAt: new Date('2026-06-05T10:00:00.000Z'),
    })

    const createReq = new NextRequest('http://localhost/api/invoice-templates', {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid_token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Monthly Retainer',
        clientEmail: 'client@acme.com',
        clientName: 'Acme Corp',
        description: 'Monthly software engineering retainer',
        amount: 3500,
        currency: 'USDC',
      }),
    })

    const createRes = await POST(createReq)
    expect(createRes.status).toBe(201)
    const createBody = await createRes.json()
    expect(createBody.template.name).toBe('Monthly Retainer')

    // Second creation with the same (userId, name) returns 409
    mockPrisma.invoiceTemplate.findUnique.mockResolvedValueOnce({
      id: 'tpl_1',
      userId: 'user_tpl_1',
      name: 'Monthly Retainer',
    })

    const dupReq = new NextRequest('http://localhost/api/invoice-templates', {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid_token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Monthly Retainer',
        description: 'Duplicate template name',
        amount: 2000,
        currency: 'USDC',
      }),
    })

    const dupRes = await POST(dupReq)
    expect(dupRes.status).toBe(409)
    const dupBody = await dupRes.json()
    expect(dupBody.code).toBe('TEMPLATE_NAME_ALREADY_EXISTS')
  })

  it('validates amount is positive and currency is in the supported set', async () => {
    const zeroAmountReq = new NextRequest(
      'http://localhost/api/invoice-templates',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Invalid Zero Template',
          description: 'Zero amount test',
          amount: 0,
          currency: 'USD',
        }),
      },
    )
    const zeroRes = await POST(zeroAmountReq)
    expect(zeroRes.status).toBe(400)
    const zeroBody = await zeroRes.json()
    expect(zeroBody.code).toBe('INVALID_TEMPLATE_AMOUNT')

    const unsupportedCurrencyReq = new NextRequest(
      'http://localhost/api/invoice-templates',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Unsupported Currency Template',
          description: 'Invalid currency test',
          amount: 250,
          currency: 'DOGE',
        }),
      },
    )
    const currRes = await POST(unsupportedCurrencyReq)
    expect(currRes.status).toBe(400)
    const currBody = await currRes.json()
    expect(currBody.code).toBe('UNSUPPORTED_CURRENCY')
    expect(mockPrisma.invoiceTemplate.create).not.toHaveBeenCalled()
  })

  it('supports instantiating a new invoice from a saved template and listing templates on GET', async () => {
    mockPrisma.invoiceTemplate.findUnique.mockResolvedValueOnce({
      id: 'tpl_saved_1',
      userId: 'user_tpl_1',
      name: 'Design Sprint Package',
      clientEmail: 'founder@startup.io',
      clientName: 'Startup Inc',
      description: '5-day product design sprint',
      amount: '4800.00',
      currency: 'USD',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    })

    mockPrisma.invoice.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'inv_from_tpl_1',
        ...data,
        createdAt: new Date('2026-06-05T12:00:00.000Z'),
      }),
    )

    const instReq = new NextRequest('http://localhost/api/invoice-templates', {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid_token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'instantiate',
        templateId: 'tpl_saved_1',
      }),
    })

    const instRes = await POST(instReq)
    expect(instRes.status).toBe(201)
    const instBody = await instRes.json()

    expect(instBody.instantiated).toBe(true)
    expect(instBody.invoice).toMatchObject({
      id: 'inv_from_tpl_1',
      userId: 'user_tpl_1',
      clientEmail: 'founder@startup.io',
      clientName: 'Startup Inc',
      description: '5-day product design sprint',
      amount: 4800,
      currency: 'USD',
      status: 'pending',
    })

    // GET lists saved templates for the user
    mockPrisma.invoiceTemplate.findMany.mockResolvedValueOnce([
      {
        id: 'tpl_saved_1',
        userId: 'user_tpl_1',
        name: 'Design Sprint Package',
        amount: '4800.00',
        currency: 'USD',
      },
    ])
    const getReq = new NextRequest('http://localhost/api/invoice-templates', {
      method: 'GET',
      headers: { authorization: 'Bearer valid_token' },
    })
    const getRes = await GET(getReq)
    expect(getRes.status).toBe(200)
    const getBody = await getRes.json()
    expect(getBody.total).toBe(1)
  })
})
