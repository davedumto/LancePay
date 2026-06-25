import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const integrationUpsert = vi.fn()
const integrationFindFirst = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    integration: { upsert: integrationUpsert, findFirst: integrationFindFirst },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

const URL = 'http://localhost/api/routes-b/integrations/slack'

function req(body: object, token: string | null = 'tok') {
  const h = new Headers({ 'content-type': 'application/json' })
  if (token) h.set('authorization', `Bearer ${token}`)
  return new NextRequest(URL, { method: 'POST', headers: h, body: JSON.stringify(body) })
}

describe('POST /api/routes-b/integrations/slack', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 with no token', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/integrations/slack/route')
    const res = await POST(req({}, null))
    expect(res.status).toBe(401)
  })

  it('returns 422 when webhookUrl is not https', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    const { POST } = await import('@/app/api/routes-b/integrations/slack/route')
    const res = await POST(req({ webhookUrl: 'http://bad.url', channel: '#general' }))
    expect(res.status).toBe(422)
  })

  it('upserts slack integration and returns 200', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    integrationUpsert.mockResolvedValue({ id: 'int-1', type: 'slack', enabled: true, updatedAt: new Date() })
    const { POST } = await import('@/app/api/routes-b/integrations/slack/route')
    const res = await POST(req({
      webhookUrl: 'https://hooks.slack.com/test',
      channel: '#invoices',
    }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.integration.type).toBe('slack')
  })
})
