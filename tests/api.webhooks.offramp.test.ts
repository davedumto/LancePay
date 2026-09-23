import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const findFirst = vi.fn()
const update = vi.fn()
const sendEmail = vi.fn()

vi.mock('@/lib/db', () => ({
  prisma: {
    withdrawalTransaction: { findFirst, update },
  },
}))

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendEmail }
  },
}))

const SECRET = 'test-webhook-secret'
const URL = 'http://localhost/api/webhooks/offramp'

function makeRequest(payload: object) {
  const rawBody = JSON.stringify(payload)
  const signature = crypto.createHmac('sha256', SECRET).update(rawBody).digest('base64')
  return new NextRequest(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-yc-signature': signature },
    body: rawBody,
  })
}

describe('POST /api/webhooks/offramp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.OFFRAMP_WEBHOOK_SECRET = SECRET
    findFirst.mockResolvedValue({ id: 'wd_1' })
    update.mockResolvedValue({})
    sendEmail.mockResolvedValue({ id: 'email_1' })
  })

  it.each(['FAILED', 'Failed', 'REVERSED', 'Reversed'])(
    'fires the admin alert for mixed-case status %s',
    async (status) => {
      const { POST } = await import('@/app/api/webhooks/offramp/route')
      const res = await POST(makeRequest({ reference: 'wd_1', status, reason: 'Bank rejected' }))

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe(status.toLowerCase())
      expect(update).toHaveBeenCalledWith({
        where: { id: 'wd_1' },
        data: { status: status.toLowerCase(), error: 'Bank rejected' },
      })
      expect(sendEmail).toHaveBeenCalledOnce()
      expect(sendEmail.mock.calls[0][0].html).toContain(status.toLowerCase())
    },
  )

  it('does not fire the admin alert for a completed withdrawal', async () => {
    const { POST } = await import('@/app/api/webhooks/offramp/route')
    const res = await POST(makeRequest({ reference: 'wd_1', status: 'COMPLETED' }))

    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('completed')
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('rejects an invalid signature without touching the database', async () => {
    const { POST } = await import('@/app/api/webhooks/offramp/route')
    const req = new NextRequest(URL, {
      method: 'POST',
      headers: { 'x-yc-signature': 'bogus' },
      body: JSON.stringify({ reference: 'wd_1', status: 'FAILED' }),
    })
    const res = await POST(req)

    expect(res.status).toBe(401)
    expect(update).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
  })
})
