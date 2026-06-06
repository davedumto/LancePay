/**
 * Tests for issue #598 — recurring invoice templates
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn().mockResolvedValue({ userId: 'privy-user-1' }),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn().mockImplementation(({ where }: any) => {
        if (where.privyId === 'privy-user-1') return Promise.resolve({ id: 'user-1', privyId: 'privy-user-1' })
        if (where.id === 'client-1') return Promise.resolve({ id: 'client-1', email: 'client@example.com', name: 'Client One' })
        return Promise.resolve(null)
      }),
    },
    invoice: {
      create: vi.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: 'inv-new',
          invoiceNumber: data.invoiceNumber ?? 'INV-TEST',
          status: 'pending',
          amount: data.amount,
          currency: data.currency,
          paymentLink: data.paymentLink ?? 'https://lancepay.app/pay/INV-TEST',
        }),
      ),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}))

vi.mock('@/lib/utils', () => ({
  generateInvoiceNumber: vi.fn().mockReturnValue('INV-TEST-001'),
}))

import { GET as listTemplates, POST as createTemplate, clearTemplateStore } from '../invoices/templates/route'
import { GET as getTemplate, PATCH as patchTemplate, DELETE as deleteTemplate } from '../invoices/templates/[id]/route'
import { POST as instantiate } from '../invoices/templates/[id]/instantiate/route'

function makeReq(method: string, body?: object, path = '/api/routes-b/invoices/templates') {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }) as any
}

const validTemplate = {
  name: 'Monthly Retainer',
  clientId: 'client-1',
  amount: 500,
  currency: 'USD',
  cadence: 'monthly',
  nextRunAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
}

describe('POST /invoices/templates', () => {
  beforeEach(() => clearTemplateStore())

  it('creates a template', async () => {
    const res = await createTemplate(makeReq('POST', validTemplate))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.template).toMatchObject({ name: 'Monthly Retainer', cadence: 'monthly', amount: 500 })
    expect(body.template.id).toBeTruthy()
  })

  it('rejects missing name', async () => {
    const res = await createTemplate(makeReq('POST', { ...validTemplate, name: '' }))
    expect(res.status).toBe(400)
  })

  it('rejects invalid cadence', async () => {
    const res = await createTemplate(makeReq('POST', { ...validTemplate, cadence: 'daily' }))
    expect(res.status).toBe(400)
  })

  it('rejects non-positive amount', async () => {
    const res = await createTemplate(makeReq('POST', { ...validTemplate, amount: -10 }))
    expect(res.status).toBe(400)
  })
})

describe('GET /invoices/templates', () => {
  beforeEach(() => clearTemplateStore())

  it('lists templates for user', async () => {
    await createTemplate(makeReq('POST', validTemplate))
    const res = await listTemplates(makeReq('GET'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.templates).toHaveLength(1)
  })

  it('returns empty list when no templates', async () => {
    const res = await listTemplates(makeReq('GET'))
    const body = await res.json()
    expect(body.templates).toHaveLength(0)
  })
})

describe('GET/PATCH/DELETE /invoices/templates/[id]', () => {
  let templateId: string

  beforeEach(async () => {
    clearTemplateStore()
    const res = await createTemplate(makeReq('POST', validTemplate))
    const body = await res.json()
    templateId = body.template.id
  })

  it('gets a template by id', async () => {
    const res = await getTemplate(makeReq('GET'), { params: Promise.resolve({ id: templateId }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.template.id).toBe(templateId)
  })

  it('returns 404 for unknown id', async () => {
    const res = await getTemplate(makeReq('GET'), { params: Promise.resolve({ id: 'no-such' }) })
    expect(res.status).toBe(404)
  })

  it('patches a template', async () => {
    const res = await patchTemplate(makeReq('PATCH', { amount: 750 }), { params: Promise.resolve({ id: templateId }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.template.amount).toBe(750)
  })

  it('deletes a template', async () => {
    const res = await deleteTemplate(makeReq('DELETE'), { params: Promise.resolve({ id: templateId }) })
    expect(res.status).toBe(204)
    // Confirm gone
    const getRes = await getTemplate(makeReq('GET'), { params: Promise.resolve({ id: templateId }) })
    expect(getRes.status).toBe(404)
  })
})

describe('POST /invoices/templates/[id]/instantiate', () => {
  let templateId: string

  beforeEach(async () => {
    clearTemplateStore()
    const res = await createTemplate(makeReq('POST', validTemplate))
    const body = await res.json()
    templateId = body.template.id
  })

  it('creates an invoice from template', async () => {
    const res = await instantiate(makeReq('POST'), { params: Promise.resolve({ id: templateId }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.invoice).toHaveProperty('id')
    expect(body.invoice.amount).toBe(500)
    expect(body).toHaveProperty('nextRunAt')
  })

  it('advances nextRunAt after instantiation', async () => {
    const before = (await (await listTemplates(makeReq('GET'))).json()).templates[0].nextRunAt
    await instantiate(makeReq('POST'), { params: Promise.resolve({ id: templateId }) })
    const after = (await (await listTemplates(makeReq('GET'))).json()).templates[0].nextRunAt
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime())
  })

  it('is idempotent within cadence window', async () => {
    const { prisma } = await import('@/lib/db')
    const createSpy = vi.mocked(prisma.invoice.create)
    vi.mocked(prisma.invoice.findUnique).mockResolvedValueOnce({ id: 'inv-new', invoiceNumber: 'INV-TEST-001', status: 'pending', amount: 500, currency: 'USD', paymentLink: 'https://lancepay.app/pay/INV-TEST-001' } as any)

    await instantiate(makeReq('POST'), { params: Promise.resolve({ id: templateId }) })
    const callsBefore = createSpy.mock.calls.length
    const res2 = await instantiate(makeReq('POST'), { params: Promise.resolve({ id: templateId }) })
    expect(createSpy.mock.calls.length).toBe(callsBefore) // no new create
    const body = await res2.json()
    expect(body.idempotent).toBe(true)
  })

  it('returns 404 for unknown template', async () => {
    const res = await instantiate(makeReq('POST'), { params: Promise.resolve({ id: 'no-such' }) })
    expect(res.status).toBe(404)
  })
})
