import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const storedEntries: Array<{
  id: string
  type: string
  value: string
  reason: string
  createdAt: Date
}> = []

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    securityWatchlist: {
      findMany: vi.fn(),
      create: vi.fn(async ({ data }: { data: { type: string; value: string; reason: string } }) => {
        const entry = {
          id: `watch-${storedEntries.length + 1}`,
          type: data.type,
          value: data.value,
          reason: data.reason,
          createdAt: new Date(),
        }
        storedEntries.push(entry)
        return entry
      }),
      findFirst: vi.fn(async ({ where }: { where: { value: string; type?: string } }) => {
        return (
          storedEntries.find(
            (e) => e.value === where.value && (!where.type || e.type === where.type),
          ) ?? null
        )
      }),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { POST } from './route'
import { GET as checkWatchlist } from './check/route'

function makePostRequest(body: unknown) {
  return new NextRequest('http://localhost/api/security-watchlist', {
    method: 'POST',
    headers: {
      authorization: 'Bearer admin-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

function makeCheckRequest(query: string) {
  return new NextRequest(`http://localhost/api/security-watchlist/check${query}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  storedEntries.length = 0
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-admin' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    id: 'admin-1',
    email: 'admin@lancepay.com',
    role: 'admin',
  } as any)
})

describe('Security watchlist write + check case normalization (#1651)', () => {
  it('normalizes mixed-case email on POST so differently-cased check requests match', async () => {
    const createRes = await POST(
      makePostRequest({
        type: 'EMAIL',
        value: '  Fraudster@Example.COM  ',
        reason: 'Phishing campaign',
      }),
    )
    expect(createRes.status).toBe(201)
    const { entry } = await createRes.json()
    expect(entry.type).toBe('email')
    expect(entry.value).toBe('fraudster@example.com')

    const checkRes = await checkWatchlist(
      makeCheckRequest('?value=fraudster@EXAMPLE.com&type=email'),
    )
    expect(checkRes.status).toBe(200)
    expect(await checkRes.json()).toEqual({ match: true, type: 'email' })
  })

  it('normalizes mixed-case 0x wallet address on POST so differently-cased check requests match', async () => {
    const createRes = await POST(
      makePostRequest({
        type: 'wallet',
        value: ' 0xDeAdBeEf123456 ',
        reason: 'OFAC sanctioned address',
      }),
    )
    expect(createRes.status).toBe(201)
    const { entry } = await createRes.json()
    expect(entry.value).toBe('0xdeadbeef123456')

    const checkRes = await checkWatchlist(
      makeCheckRequest('?value=0xDEADBEEF123456&type=wallet'),
    )
    expect(checkRes.status).toBe(200)
    expect(await checkRes.json()).toEqual({ match: true, type: 'wallet' })
  })
})
