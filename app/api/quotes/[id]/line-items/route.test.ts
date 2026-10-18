import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockPrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  quote: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  quoteLineItem: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}))

const mockVerifyAuthToken = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { GET, POST, PATCH, DELETE } from './route'

describe('GET, POST, PATCH, DELETE /api/quotes/[id]/line-items', () => {
  let itemsStore: Array<Record<string, any>> = []

  beforeEach(() => {
    vi.clearAllMocks()
    itemsStore = []
    mockVerifyAuthToken.mockResolvedValue({ userId: 'did:privy:user_quote_1' })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user_quote_1' })
    mockPrisma.quote.findUnique.mockResolvedValue({
      id: 'quote_100',
      userId: 'user_quote_1',
      clientEmail: 'client@acme.com',
      amount: 0,
      currency: 'USD',
      status: 'pending',
    })

    mockPrisma.quoteLineItem.findMany.mockImplementation(async () =>
      [...itemsStore].sort((a, b) => a.position - b.position),
    )
    mockPrisma.quoteLineItem.create.mockImplementation(
      async ({ data }: { data: Record<string, any> }) => {
        const created = {
          id: `qli_${itemsStore.length + 1}`,
          ...data,
          createdAt: new Date('2026-06-05T10:00:00.000Z'),
          updatedAt: new Date('2026-06-05T10:00:00.000Z'),
        }
        itemsStore.push(created)
        return created
      },
    )
    mockPrisma.quoteLineItem.update.mockImplementation(
      async ({
        where,
        data,
      }: {
        where: { id: string }
        data: Record<string, any>
      }) => {
        const target = itemsStore.find((it) => it.id === where.id)
        if (target) {
          Object.assign(target, data)
        }
        return target
      },
    )
    mockPrisma.quoteLineItem.delete.mockImplementation(
      async ({ where }: { where: { id: string } }) => {
        itemsStore = itemsStore.filter((it) => it.id !== where.id)
        return { id: where.id }
      },
    )
    mockPrisma.quote.update.mockResolvedValue({ id: 'quote_100' })
  })

  it('validates quantity and unitPrice are non-negative', async () => {
    const negQtyReq = new NextRequest(
      'http://localhost/api/quotes/quote_100/line-items',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          description: 'Frontend development',
          quantity: -2,
          unitPrice: 120,
        }),
      },
    )
    const negQtyRes = await POST(negQtyReq, { params: { id: 'quote_100' } })
    expect(negQtyRes.status).toBe(400)
    const negQtyBody = await negQtyRes.json()
    expect(negQtyBody.code).toBe('INVALID_QUANTITY')

    const negPriceReq = new NextRequest(
      'http://localhost/api/quotes/quote_100/line-items',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          description: 'Frontend development',
          quantity: 5,
          unitPrice: -50,
        }),
      },
    )
    const negPriceRes = await POST(negPriceReq, { params: { id: 'quote_100' } })
    expect(negPriceRes.status).toBe(400)
    const negPriceBody = await negPriceRes.json()
    expect(negPriceBody.code).toBe('INVALID_UNIT_PRICE')
    expect(mockPrisma.quoteLineItem.create).not.toHaveBeenCalled()
  })

  it('maintains stable user-controllable position values and recomputes the quote total when items are added, reordered, updated, or removed', async () => {
    // 1. Add item A (qty 10 * $100 = $1000) -> position 0
    const addAReq = new NextRequest(
      'http://localhost/api/quotes/quote_100/line-items',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          description: 'Architecture & Discovery',
          quantity: 10,
          unitPrice: 100,
        }),
      },
    )
    const addARes = await POST(addAReq, { params: { id: 'quote_100' } })
    expect(addARes.status).toBe(201)
    const addABody = await addARes.json()
    expect(addABody.total).toBe(1000)
    expect(addABody.lineItem.position).toBe(0)

    // 2. Add item B (qty 5 * $80 = $400) -> position 1, total = $1400
    const addBReq = new NextRequest(
      'http://localhost/api/quotes/quote_100/line-items',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          description: 'API Implementation',
          quantity: 5,
          unitPrice: 80,
        }),
      },
    )
    const addBRes = await POST(addBReq, { params: { id: 'quote_100' } })
    expect(addBRes.status).toBe(201)
    const addBBody = await addBRes.json()
    expect(addBBody.total).toBe(1400)
    expect(mockPrisma.quote.update).toHaveBeenLastCalledWith({
      where: { id: 'quote_100' },
      data: { amount: 1400 },
    })

    // 3. Reorder via PATCH orderedIds: [qli_2, qli_1]
    const reorderReq = new NextRequest(
      'http://localhost/api/quotes/quote_100/line-items',
      {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          orderedIds: ['qli_2', 'qli_1'],
        }),
      },
    )
    const reorderRes = await PATCH(reorderReq, { params: { id: 'quote_100' } })
    expect(reorderRes.status).toBe(200)
    const reorderBody = await reorderRes.json()
    expect(
      reorderBody.lineItems.map((i: any) => ({
        id: i.id,
        position: i.position,
      })),
    ).toEqual([
      { id: 'qli_2', position: 0 },
      { id: 'qli_1', position: 1 },
    ])

    // 4. Remove qli_2 via DELETE -> qli_1 shifts to position 0, total recomputes to $1000
    const delReq = new NextRequest(
      'http://localhost/api/quotes/quote_100/line-items?lineItemId=qli_2',
      {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const delRes = await DELETE(delReq, { params: { id: 'quote_100' } })
    expect(delRes.status).toBe(200)
    const delBody = await delRes.json()
    expect(delBody.total).toBe(1000)
    expect(delBody.lineItems).toHaveLength(1)
    expect(delBody.lineItems[0]).toMatchObject({
      id: 'qli_1',
      position: 0,
      lineTotal: 1000,
    })

    // 5. GET returns the ordered line items and total
    const getReq = new NextRequest(
      'http://localhost/api/quotes/quote_100/line-items',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const getRes = await GET(getReq, { params: { id: 'quote_100' } })
    expect(getRes.status).toBe(200)
    const getBody = await getRes.json()
    expect(getBody.total).toBe(1000)
  })
})
