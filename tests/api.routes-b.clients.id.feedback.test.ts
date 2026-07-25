import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const feedbackFindMany = vi.fn()
const feedbackCreate = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    clientFeedback: { findMany: feedbackFindMany, create: feedbackCreate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))

const BASE_URL = 'http://localhost/api/routes-b/clients/client_1/feedback'

function makeRequest(
  headers: Record<string, string> = { authorization: 'Bearer token' },
  body?: unknown,
) {
  return new NextRequest(BASE_URL, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const routeParams = { params: Promise.resolve({ id: 'client_1' }) }

async function importRoute() {
  return import('@/app/api/routes-b/clients/[id]/feedback/route')
}

describe('GET /api/routes-b/clients/[id]/feedback (#1190)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no auth token is provided', async () => {
    const { GET } = await importRoute()
    const response = await GET(makeRequest({}), routeParams)

    expect(response.status).toBe(401)
    expect(userFindUnique).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await importRoute()
    const response = await GET(makeRequest(), routeParams)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'Invalid token' })
  })

  it('returns 404 when the user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)

    const { GET } = await importRoute()
    const response = await GET(makeRequest(), routeParams)

    expect(response.status).toBe(404)
  })

  it('returns 404 when the client is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValueOnce({ id: 'user_1' })
    userFindUnique.mockResolvedValueOnce(null)

    const { GET } = await importRoute()
    const response = await GET(makeRequest(), routeParams)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: 'Client not found' })
  })

  it('returns the feedback list for the client', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValueOnce({ id: 'user_1' })
    userFindUnique.mockResolvedValueOnce({ id: 'client_1' })
    feedbackFindMany.mockResolvedValue([
      { id: 'fb_1', rating: 5, comment: 'Great to work with', createdAt: new Date(), updatedAt: new Date() },
    ])

    const { GET } = await importRoute()
    const response = await GET(makeRequest(), routeParams)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.feedback).toHaveLength(1)
    expect(body.feedback[0]).toMatchObject({ id: 'fb_1', rating: 5 })
    expect(feedbackFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user_1', clientId: 'client_1' },
        orderBy: { createdAt: 'desc' },
      }),
    )
  })

  it('returns an empty array when no feedback exists', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValueOnce({ id: 'user_1' })
    userFindUnique.mockResolvedValueOnce({ id: 'client_1' })
    feedbackFindMany.mockResolvedValue([])

    const { GET } = await importRoute()
    const response = await GET(makeRequest(), routeParams)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ feedback: [] })
  })
})

describe('POST /api/routes-b/clients/[id]/feedback (#1190)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValueOnce({ id: 'user_1' })
    userFindUnique.mockResolvedValueOnce({ id: 'client_1' })
  })

  it('creates feedback and returns 201', async () => {
    feedbackCreate.mockResolvedValue({
      id: 'fb_1',
      rating: 4,
      comment: 'Paid on time',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const { POST } = await importRoute()
    const response = await POST(
      makeRequest(undefined, { rating: 4, comment: 'Paid on time' }),
      routeParams,
    )

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.feedback).toMatchObject({ id: 'fb_1', rating: 4 })
    expect(feedbackCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user_1',
          clientId: 'client_1',
          rating: 4,
          comment: 'Paid on time',
        }),
      }),
    )
  })

  it('stores null when the comment is omitted', async () => {
    feedbackCreate.mockResolvedValue({
      id: 'fb_2',
      rating: 3,
      comment: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const { POST } = await importRoute()
    const response = await POST(makeRequest(undefined, { rating: 3 }), routeParams)

    expect(response.status).toBe(201)
    expect(feedbackCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ comment: null }),
      }),
    )
  })

  it('returns 400 for invalid JSON', async () => {
    const request = new NextRequest(BASE_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: 'not-json',
    })

    const { POST } = await importRoute()
    const response = await POST(request, routeParams)

    expect(response.status).toBe(400)
    expect(feedbackCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when rating is missing', async () => {
    const { POST } = await importRoute()
    const response = await POST(makeRequest(undefined, { comment: 'no rating' }), routeParams)

    expect(response.status).toBe(400)
    expect(feedbackCreate).not.toHaveBeenCalled()
  })

  it.each([0, 6, 2.5, '4'])('returns 400 for invalid rating %p', async (rating) => {
    const { POST } = await importRoute()
    const response = await POST(makeRequest(undefined, { rating }), routeParams)

    expect(response.status).toBe(400)
    expect(feedbackCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when the comment exceeds the maximum length', async () => {
    const { POST } = await importRoute()
    const response = await POST(
      makeRequest(undefined, { rating: 4, comment: 'x'.repeat(2001) }),
      routeParams,
    )

    expect(response.status).toBe(400)
    expect(feedbackCreate).not.toHaveBeenCalled()
  })

  it('returns 500 when the database write fails', async () => {
    feedbackCreate.mockRejectedValue(new Error('db down'))

    const { POST } = await importRoute()
    const response = await POST(makeRequest(undefined, { rating: 4 }), routeParams)

    expect(response.status).toBe(500)
    expect(loggerError).toHaveBeenCalled()
  })
})
