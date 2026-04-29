import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const contactCount = vi.fn()
const contactFindMany = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    contact: { count: contactCount, findMany: contactFindMany },
  },
}))

function makeRequest(url = 'http://localhost/api/routes-b/contacts/export.csv?search=ali') {
  return new NextRequest(url, {
    headers: { authorization: 'Bearer token' },
  })
}

describe('GET /api/routes-b/contacts/export.csv', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
  })

  it('returns CSV header for empty result', async () => {
    contactCount.mockResolvedValue(0)
    contactFindMany.mockResolvedValueOnce([] as never)
    const { GET } = await import('@/app/api/routes-b/contacts/export.csv/route')
    const response = await GET(makeRequest())
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/csv')
    expect(await response.text()).toBe('id,name,email,company,notes,createdAt,updatedAt\n')
  })

  it('honors filters from list endpoint', async () => {
    contactCount.mockResolvedValue(1)
    contactFindMany
      .mockResolvedValueOnce([
        {
          id: 'contact_1',
          name: 'Alice',
          email: 'alice@example.com',
          company: 'LancePay',
          notes: 'VIP',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      ] as never)
      .mockResolvedValueOnce([] as never)
    const { GET } = await import('@/app/api/routes-b/contacts/export.csv/route')
    const response = await GET(makeRequest('http://localhost/api/routes-b/contacts/export.csv?search=alice'))
    expect(response.status).toBe(200)
    await response.text()
    expect(contactFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ name: expect.objectContaining({ contains: 'alice' }) }),
            expect.objectContaining({ email: expect.objectContaining({ contains: 'alice' }) }),
          ]),
        }),
      }),
    )
  })

  it('rejects export when row count exceeds cap', async () => {
    contactCount.mockResolvedValue(100_001)
    const { GET } = await import('@/app/api/routes-b/contacts/export.csv/route')
    const response = await GET(makeRequest())
    expect(response.status).toBe(413)
  })
})

