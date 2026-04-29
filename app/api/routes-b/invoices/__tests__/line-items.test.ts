import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

import {
  MAX_ITEMS_PER_INVOICE,
  computeTotals,
  resetInvoiceLineItemsStore,
  validateNewItem,
  validateItemPatch,
} from '../../_lib/invoice-line-items'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: {
          update: vi.fn().mockResolvedValue({}),
        },
      }),
    ),
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFindUnique = vi.mocked(prisma.invoice.findUnique)

const fakeUser = { id: 'user-1', privyId: 'privy-1' }
const pendingInvoice = { id: 'inv-1', userId: 'user-1', status: 'pending' }

beforeEach(() => {
  vi.resetAllMocks()
  resetInvoiceLineItemsStore()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFindUnique.mockResolvedValue(fakeUser as never)
  mockedInvoiceFindUnique.mockResolvedValue(pendingInvoice as never)
  // Re-install $transaction default behavior after resetAllMocks
  vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
    (fn as (tx: unknown) => Promise<unknown>)({
      invoice: { update: vi.fn().mockResolvedValue({}) },
    }) as never,
  )
})

function makeRequest(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown): NextRequest {
  const init: RequestInit = {
    method,
    headers: { authorization: 'Bearer token' },
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  return new NextRequest('http://localhost/api/routes-b/invoices/inv-1/items', init)
}

const idParams = { params: Promise.resolve({ id: 'inv-1' }) }

const itemParams = (itemId: string) => ({
  params: Promise.resolve({ id: 'inv-1', itemId }),
})

describe('validateNewItem / validateItemPatch', () => {
  it('accepts a valid item', () => {
    const res = validateNewItem({ name: 'Hours', quantity: 10, unitPrice: 50, taxRate: 0.1 })
    expect(res.ok).toBe(true)
  })

  it('rejects bad fields on creation', () => {
    expect(validateNewItem({ name: '', quantity: 1, unitPrice: 1, taxRate: 0 }).ok).toBe(false)
    expect(validateNewItem({ name: 'x', quantity: 0, unitPrice: 1, taxRate: 0 }).ok).toBe(false)
    expect(validateNewItem({ name: 'x', quantity: 1.5, unitPrice: 1, taxRate: 0 }).ok).toBe(false)
    expect(validateNewItem({ name: 'x', quantity: 1, unitPrice: -1, taxRate: 0 }).ok).toBe(false)
    expect(validateNewItem({ name: 'x', quantity: 1, unitPrice: 1, taxRate: 1.1 }).ok).toBe(false)
  })

  it('rejects empty patches and bad fields', () => {
    expect(validateItemPatch({}).ok).toBe(false)
    expect(validateItemPatch({ quantity: 0 }).ok).toBe(false)
    expect(validateItemPatch({ unitPrice: -1 }).ok).toBe(false)
  })

  it('accepts a partial patch', () => {
    const res = validateItemPatch({ quantity: 5 })
    expect(res.ok).toBe(true)
  })
})

describe('computeTotals', () => {
  it('sums subtotal and tax across items', () => {
    const totals = computeTotals([
      {
        id: 'a',
        name: 'a',
        quantity: 2,
        unitPrice: 50,
        taxRate: 0.1,
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'b',
        name: 'b',
        quantity: 1,
        unitPrice: 100,
        taxRate: 0,
        createdAt: '',
        updatedAt: '',
      },
    ])
    expect(totals.subtotal).toBe(200)
    expect(totals.taxTotal).toBe(10)
    expect(totals.total).toBe(210)
  })

  it('returns zeros for an empty list', () => {
    expect(computeTotals([])).toEqual({ subtotal: 0, taxTotal: 0, total: 0 })
  })
})

describe('POST /api/routes-b/invoices/[id]/items', () => {
  it('creates an item and updates the invoice total in the same transaction', async () => {
    const txInvoiceUpdate = vi.fn().mockResolvedValue({})
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
      (fn as (tx: unknown) => Promise<unknown>)({
        invoice: { update: txInvoiceUpdate },
      }) as never,
    )

    const { POST } = await import('../[id]/items/route')
    const res = await POST(
      makeRequest('POST', { name: 'Hours', quantity: 2, unitPrice: 50, taxRate: 0.1 }),
      idParams,
    )
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.totals.total).toBe(110)
    expect(txInvoiceUpdate).toHaveBeenCalledOnce()
    expect(txInvoiceUpdate).toHaveBeenCalledWith({
      where: { id: 'inv-1' },
      data: { amount: 110 },
    })
  })

  it('rejects creating a 51st item', async () => {
    const { POST } = await import('../[id]/items/route')
    for (let i = 0; i < MAX_ITEMS_PER_INVOICE; i += 1) {
      const res = await POST(
        makeRequest('POST', {
          name: `item ${i}`,
          quantity: 1,
          unitPrice: 1,
          taxRate: 0,
        }),
        idParams,
      )
      expect(res.status).toBe(201)
    }

    const overCap = await POST(
      makeRequest('POST', { name: 'extra', quantity: 1, unitPrice: 1, taxRate: 0 }),
      idParams,
    )
    const json = await overCap.json()
    expect(overCap.status).toBe(422)
    expect(json.code).toBe('INVOICE_ITEM_CAP')
  })

  it('rejects 400 on invalid body', async () => {
    const { POST } = await import('../[id]/items/route')
    const res = await POST(
      makeRequest('POST', { name: '', quantity: 1, unitPrice: 1, taxRate: 0 }),
      idParams,
    )
    expect(res.status).toBe(400)
  })

  it('rejects edits on a non-pending invoice', async () => {
    mockedInvoiceFindUnique.mockResolvedValue({ ...pendingInvoice, status: 'paid' } as never)
    const { POST } = await import('../[id]/items/route')
    const res = await POST(
      makeRequest('POST', { name: 'x', quantity: 1, unitPrice: 1, taxRate: 0 }),
      idParams,
    )
    const json = await res.json()
    expect(res.status).toBe(422)
    expect(json.code).toBe('INVOICE_NOT_EDITABLE')
  })

  it('returns 403 for cross-user invoice', async () => {
    mockedInvoiceFindUnique.mockResolvedValue({ ...pendingInvoice, userId: 'other' } as never)
    const { POST } = await import('../[id]/items/route')
    const res = await POST(
      makeRequest('POST', { name: 'x', quantity: 1, unitPrice: 1, taxRate: 0 }),
      idParams,
    )
    expect(res.status).toBe(403)
  })

  it('rolls back the in-memory commit when the DB transaction fails', async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error('db down'))

    const { POST, GET } = await import('../[id]/items/route')

    const failed = await POST(
      makeRequest('POST', { name: 'x', quantity: 1, unitPrice: 1, taxRate: 0 }),
      idParams,
    )
    expect(failed.status).toBe(500)

    // Restore default tx behavior so GET succeeds
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
      (fn as (tx: unknown) => Promise<unknown>)({
        invoice: { update: vi.fn().mockResolvedValue({}) },
      }) as never,
    )

    const listRes = await GET(makeRequest('GET'), idParams)
    const json = await listRes.json()
    expect(json.items).toEqual([])
    expect(json.totals.total).toBe(0)
  })
})

describe('GET /api/routes-b/invoices/[id]/items', () => {
  it('returns items + totals after creation and preserves order across mutations', async () => {
    const { POST, GET } = await import('../[id]/items/route')

    const a = await POST(
      makeRequest('POST', { name: 'A', quantity: 1, unitPrice: 10, taxRate: 0 }),
      idParams,
    )
    const b = await POST(
      makeRequest('POST', { name: 'B', quantity: 1, unitPrice: 20, taxRate: 0 }),
      idParams,
    )
    const c = await POST(
      makeRequest('POST', { name: 'C', quantity: 1, unitPrice: 30, taxRate: 0 }),
      idParams,
    )

    const aJson = await a.json()
    const bJson = await b.json()
    const cJson = await c.json()

    const list = await GET(makeRequest('GET'), idParams)
    const listJson = await list.json()

    expect(listJson.items.map((i: { id: string }) => i.id)).toEqual([
      aJson.item.id,
      bJson.item.id,
      cJson.item.id,
    ])
    expect(listJson.totals.total).toBe(60)

    const { PATCH } = await import('../[id]/items/[itemId]/route')
    await PATCH(makeRequest('PATCH', { quantity: 2 }), itemParams(bJson.item.id))

    const list2 = await GET(makeRequest('GET'), idParams)
    const list2Json = await list2.json()
    expect(list2Json.items.map((i: { id: string }) => i.id)).toEqual([
      aJson.item.id,
      bJson.item.id,
      cJson.item.id,
    ])
    expect(list2Json.totals.total).toBe(80)
  })
})

describe('PATCH /api/routes-b/invoices/[id]/items/[itemId]', () => {
  it('updates an item and recomputes totals', async () => {
    const { POST } = await import('../[id]/items/route')
    const create = await POST(
      makeRequest('POST', { name: 'A', quantity: 1, unitPrice: 100, taxRate: 0.1 }),
      idParams,
    )
    const created = await create.json()
    expect(create.status).toBe(201)
    expect(created.totals.total).toBe(110)

    const txInvoiceUpdate = vi.fn().mockResolvedValue({})
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
      (fn as (tx: unknown) => Promise<unknown>)({
        invoice: { update: txInvoiceUpdate },
      }) as never,
    )

    const { PATCH } = await import('../[id]/items/[itemId]/route')
    const res = await PATCH(
      makeRequest('PATCH', { quantity: 3 }),
      itemParams(created.item.id),
    )
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.item.quantity).toBe(3)
    expect(json.totals.total).toBe(330)
    expect(txInvoiceUpdate).toHaveBeenCalledWith({
      where: { id: 'inv-1' },
      data: { amount: 330 },
    })
  })

  it('returns 404 for unknown itemId', async () => {
    const { PATCH } = await import('../[id]/items/[itemId]/route')
    const res = await PATCH(makeRequest('PATCH', { quantity: 2 }), itemParams('nope'))
    expect(res.status).toBe(404)
  })

  it('rejects edits on a non-pending invoice', async () => {
    mockedInvoiceFindUnique.mockResolvedValue({ ...pendingInvoice, status: 'paid' } as never)
    const { PATCH } = await import('../[id]/items/[itemId]/route')
    const res = await PATCH(makeRequest('PATCH', { quantity: 2 }), itemParams('any'))
    expect(res.status).toBe(422)
  })
})

describe('DELETE /api/routes-b/invoices/[id]/items/[itemId]', () => {
  it('removes an item, recomputes totals and leaves invoice valid when last is deleted', async () => {
    const { POST } = await import('../[id]/items/route')
    const create = await POST(
      makeRequest('POST', { name: 'A', quantity: 1, unitPrice: 50, taxRate: 0 }),
      idParams,
    )
    const created = await create.json()
    expect(created.totals.total).toBe(50)

    const txInvoiceUpdate = vi.fn().mockResolvedValue({})
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
      (fn as (tx: unknown) => Promise<unknown>)({
        invoice: { update: txInvoiceUpdate },
      }) as never,
    )

    const { DELETE } = await import('../[id]/items/[itemId]/route')
    const res = await DELETE(
      makeRequest('DELETE'),
      itemParams(created.item.id),
    )
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.totals).toEqual({ subtotal: 0, taxTotal: 0, total: 0 })
    expect(txInvoiceUpdate).toHaveBeenCalledWith({
      where: { id: 'inv-1' },
      data: { amount: 0 },
    })

    const { GET } = await import('../[id]/items/route')
    const list = await GET(makeRequest('GET'), idParams)
    const listJson = await list.json()
    expect(listJson.items).toEqual([])
    expect(listJson.totals.total).toBe(0)
  })

  it('returns 404 for unknown itemId', async () => {
    const { DELETE } = await import('../[id]/items/[itemId]/route')
    const res = await DELETE(makeRequest('DELETE'), itemParams('nope'))
    expect(res.status).toBe(404)
  })
})
