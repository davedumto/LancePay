import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const clientNoteFindMany = vi.fn()
const clientNoteCreate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    clientNote: {
      findMany: clientNoteFindMany,
      create: clientNoteCreate,
    },
  },
}))

const BASE_URL = 'http://localhost/api/routes-b/clients/client_1/notes'

function makeRequest(
  headers: Record<string, string> = { authorization: 'Bearer token' },
  body?: any,
) {
  return new NextRequest(BASE_URL, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
}

describe('GET /api/routes-b/clients/[id]/notes (#927)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no auth token is provided', async () => {
    const { GET } = await import('@/app/api/routes-b/clients/[id]/notes/route')
    const response = await GET(makeRequest({}), { params: Promise.resolve({ id: 'client_1' }) })

    expect(response.status).toBe(401)
    expect(userFindUnique).not.toHaveBeenCalled()
  })

  it('returns 404 when the user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-b/clients/[id]/notes/route')
    const response = await GET(makeRequest(), { params: Promise.resolve({ id: 'client_1' }) })

    expect(response.status).toBe(404)
  })

  it('returns 404 when the client is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValueOnce({ id: 'user_1' })
    userFindUnique.mockResolvedValueOnce(null)

    const { GET } = await import('@/app/api/routes-b/clients/[id]/notes/route')
    const response = await GET(makeRequest(), { params: Promise.resolve({ id: 'client_1' }) })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: 'Client not found' })
  })

  it('returns empty notes array when no notes exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValueOnce({ id: 'user_1' })
    userFindUnique.mockResolvedValueOnce({ id: 'client_1' })
    clientNoteFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-b/clients/[id]/notes/route')
    const response = await GET(makeRequest(), { params: Promise.resolve({ id: 'client_1' }) })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.notes).toEqual([])
  })

  it('returns notes for the client', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValueOnce({ id: 'user_1' })
    userFindUnique.mockResolvedValueOnce({ id: 'client_1' })
    clientNoteFindMany.mockResolvedValue([
      {
        id: 'note_1',
        clientId: 'client_1',
        content: 'Great client, always pays on time',
        createdAt: new Date('2026-06-20T00:00:00Z'),
        updatedAt: new Date('2026-06-20T00:00:00Z'),
      },
    ])

    const { GET } = await import('@/app/api/routes-b/clients/[id]/notes/route')
    const response = await GET(makeRequest(), { params: Promise.resolve({ id: 'client_1' }) })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.notes).toHaveLength(1)
    expect(body.notes[0].content).toBe('Great client, always pays on time')
  })
})

describe('POST /api/routes-b/clients/[id]/notes (#927)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no auth token is provided', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/clients/[id]/notes/route')
    const response = await POST(makeRequest({}, { content: 'Test note' }), {
      params: Promise.resolve({ id: 'client_1' }),
    })

    expect(response.status).toBe(401)
  })

  it('returns 400 when content is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValueOnce({ id: 'user_1' })
    userFindUnique.mockResolvedValueOnce({ id: 'client_1' })

    const { POST } = await import('@/app/api/routes-b/clients/[id]/notes/route')
    const response = await POST(makeRequest({}, {}), { params: Promise.resolve({ id: 'client_1' }) })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'content is required and must be a non-empty string',
    })
  })

  it('returns 400 when content is empty string', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValueOnce({ id: 'user_1' })
    userFindUnique.mockResolvedValueOnce({ id: 'client_1' })

    const { POST } = await import('@/app/api/routes-b/clients/[id]/notes/route')
    const response = await POST(makeRequest({}, { content: '   ' }), {
      params: Promise.resolve({ id: 'client_1' }),
    })

    expect(response.status).toBe(400)
  })

  it('creates a note with valid data', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValueOnce({ id: 'user_1' })
    userFindUnique.mockResolvedValueOnce({ id: 'client_1' })
    clientNoteCreate.mockResolvedValue({
      id: 'note_1',
      userId: 'user_1',
      clientId: 'client_1',
      content: 'Excellent client to work with',
      createdAt: new Date('2026-06-23T00:00:00Z'),
      updatedAt: new Date('2026-06-23T00:00:00Z'),
    })

    const { POST } = await import('@/app/api/routes-b/clients/[id]/notes/route')
    const response = await POST(makeRequest({}, { content: 'Excellent client to work with' }), {
      params: Promise.resolve({ id: 'client_1' }),
    })

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.content).toBe('Excellent client to work with')
    expect(clientNoteCreate).toHaveBeenCalledWith({
      data: {
        userId: 'user_1',
        clientId: 'client_1',
        content: 'Excellent client to work with',
      },
    })
  })
})
