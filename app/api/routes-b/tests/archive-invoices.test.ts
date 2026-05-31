import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { POST as archivePost } from '../invoices/[id]/archive/route'
import { POST as unarchivePost } from '../invoices/[id]/unarchive/route'
import { GET as listInvoices } from '../invoices/route'

const authd = () => {
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'u1' } as any)
}

describe('archive/unarchive invoices', () => {
  beforeEach(() => vi.resetAllMocks())

  it('archives and unarchives', async () => {
    authd()
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue({ id: 'inv-1', userId: 'u1' } as any)
    vi.mocked(prisma.invoice.update)
      .mockResolvedValueOnce({ id: 'inv-1', status: 'paid', isConfidential: true } as any)
      .mockResolvedValueOnce({ id: 'inv-1', status: 'paid', isConfidential: false } as any)

    const headers = { authorization: 'Bearer token' }
    const archived = await archivePost(new NextRequest('http://localhost/a', { method: 'POST', headers }), { params: Promise.resolve({ id: 'inv-1' }) })
    const unarchived = await unarchivePost(new NextRequest('http://localhost/b', { method: 'POST', headers }), { params: Promise.resolve({ id: 'inv-1' }) })

    expect((await archived.json()).invoice.archived).toBe(true)
    expect((await unarchived.json()).invoice.archived).toBe(false)
  })

  it('excludes archived by default and includes with flag', async () => {
    authd()
    vi.mocked(prisma.invoice.count).mockResolvedValue(0)
    vi.mocked(prisma.invoice.findMany).mockResolvedValue([] as any)

    await listInvoices(new NextRequest('http://localhost/api/routes-b/invoices', { headers: { authorization: 'Bearer token' } }))
    expect(vi.mocked(prisma.invoice.findMany).mock.calls[0][0].where.isConfidential).toBe(false)

    await listInvoices(new NextRequest('http://localhost/api/routes-b/invoices?includeArchived=true', { headers: { authorization: 'Bearer token' } }))
    expect(vi.mocked(prisma.invoice.findMany).mock.calls[1][0].where.isConfidential).toBeUndefined()
  })
})
