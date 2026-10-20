import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, POST } from './route'

vi.mock('@vercel/blob', () => ({ put: vi.fn(), del: vi.fn(), get: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    libraryAttachment: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { del, get as getBlob, put } from '@vercel/blob'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUserFind = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>
const mockFindMany = prisma.libraryAttachment.findMany as unknown as ReturnType<typeof vi.fn>
const mockFindFirst = prisma.libraryAttachment.findFirst as unknown as ReturnType<typeof vi.fn>
const mockCreate = prisma.libraryAttachment.create as unknown as ReturnType<typeof vi.fn>
const mockVerify = verifyAuthToken as unknown as ReturnType<typeof vi.fn>
const mockPut = put as unknown as ReturnType<typeof vi.fn>
const mockDel = del as unknown as ReturnType<typeof vi.fn>
const mockGetBlob = getBlob as unknown as ReturnType<typeof vi.fn>
const URL = 'http://localhost/api/library/attachments'

function makeGet(token: string | null = 'valid-token') {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest(URL, { headers })
}

function makePost(file: File | null, token: string | null = 'valid-token') {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  const form = new FormData()
  if (file) form.set('file', file)
  return new NextRequest(URL, { method: 'POST', headers, body: form })
}

function makeFile(name = 'receipt.pdf', type = 'application/pdf', size = 8) {
  return new File([new Uint8Array(size)], name, { type })
}

describe('/api/library/attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerify.mockResolvedValue({ userId: 'privy-user' })
    mockUserFind.mockResolvedValue({ id: 'user-1' })
    mockFindMany.mockResolvedValue([{ id: 'attachment-1', fileName: 'receipt.pdf' }])
    mockFindFirst.mockResolvedValue({ fileName: 'receipt.pdf', fileUrl: 'https://blob.example/private/receipt.pdf', mimeType: 'application/pdf' })
    mockPut.mockResolvedValue({ url: 'https://blob.example/receipt.pdf' })
    mockCreate.mockResolvedValue({ id: 'attachment-1', fileName: 'receipt.pdf', fileUrl: 'https://blob.example/receipt.pdf' })
    mockDel.mockResolvedValue(undefined)
    mockGetBlob.mockResolvedValue({ stream: new ReadableStream(), blob: { contentType: 'application/pdf' } })
  })

  it('rejects unauthenticated requests', async () => {
    expect((await GET(makeGet(null))).status).toBe(401)
    expect((await POST(makePost(makeFile(), null))).status).toBe(401)
  })

  it('lists only the authenticated user library', async () => {
    const response = await GET(makeGet())
    expect(response.status).toBe(200)
    expect((await response.json()).attachments).toHaveLength(1)
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-1' } }))
  })

  it('streams a private file only after confirming ownership', async () => {
    const response = await GET(new NextRequest(`${URL}?id=attachment-1`, {
      headers: { authorization: 'Bearer valid-token' },
    }))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(mockFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'attachment-1', userId: 'user-1' } }))
    expect(mockGetBlob).toHaveBeenCalledWith('https://blob.example/private/receipt.pdf', { access: 'private' })
  })

  it('does not download another user attachment', async () => {
    mockFindFirst.mockResolvedValue(null)
    const response = await GET(new NextRequest(`${URL}?id=other-user-file`, {
      headers: { authorization: 'Bearer valid-token' },
    }))
    expect(response.status).toBe(404)
    expect(mockGetBlob).not.toHaveBeenCalled()
  })

  it('uploads a valid file to storage and saves its metadata', async () => {
    const response = await POST(makePost(makeFile()))
    expect(response.status).toBe(201)
    expect(mockPut).toHaveBeenCalledWith(expect.stringContaining('user-1/'), expect.any(File), expect.objectContaining({ access: 'private' }))
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'user-1', fileUrl: 'https://blob.example/receipt.pdf', mimeType: 'application/pdf' }),
    }))
  })

  it('rejects unsupported file types and oversized files', async () => {
    expect((await POST(makePost(makeFile('payload.exe', 'application/octet-stream')))).status).toBe(400)
    expect((await POST(makePost(makeFile('large.pdf', 'application/pdf', 25 * 1024 * 1024 + 1)))).status).toBe(400)
    expect(mockPut).not.toHaveBeenCalled()
  })

  it('removes the uploaded blob if persisting its metadata fails', async () => {
    mockCreate.mockRejectedValue(new Error('database unavailable'))
    expect((await POST(makePost(makeFile()))).status).toBe(500)
    expect(mockDel).toHaveBeenCalledWith('https://blob.example/receipt.pdf')
  })
})