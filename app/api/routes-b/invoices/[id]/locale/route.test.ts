import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceFindFirst = vi.fn()
const invoiceLocaleFindUnique = vi.fn()
const invoiceLocaleUpsert = vi.fn()
const languagePreferenceFindUnique = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: { findFirst: invoiceFindFirst },
    invoiceLocalePreference: {
      findUnique: invoiceLocaleFindUnique,
      upsert: invoiceLocaleUpsert,
    },
    languagePreference: { findUnique: languagePreferenceFindUnique },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

const URL = 'http://localhost/api/routes-b/invoices/inv-1/locale'

function req(method: string, body?: unknown, token: string | null = 'tok') {
  const h = new Headers()
  if (token) h.set('authorization', `Bearer ${token}`)
  if (body !== undefined) h.set('content-type', 'application/json')
  return new NextRequest(URL, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

const ctx = { params: Promise.resolve({ id: 'inv-1' }) }

describe('GET /api/routes-b/invoices/[id]/locale (#1118)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when unauthenticated', async () => {
    const { GET } = await import('./route')
    const res = await GET(req('GET', undefined, null), ctx)
    expect(res.status).toBe(401)
  })

  it('returns 404 when invoice not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue(null)
    const { GET } = await import('./route')
    const res = await GET(req('GET'), ctx)
    expect(res.status).toBe(404)
  })

  it('returns per-invoice override when configured', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue({ id: 'inv-1' })
    invoiceLocaleFindUnique.mockResolvedValue({
      locale: 'fr', dateFormat: 'DD/MM/YYYY', numberFormat: '1 234,56',
    })

    const { GET } = await import('./route')
    const res = await GET(req('GET'), ctx)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.locale).toBe('fr')
    expect(json.isOverride).toBe(true)
  })

  it('falls back to user language preferences', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue({ id: 'inv-1' })
    invoiceLocaleFindUnique.mockResolvedValue(null)
    languagePreferenceFindUnique.mockResolvedValue({ locale: 'es', dateFormat: null, numberFormat: null })

    const { GET } = await import('./route')
    const res = await GET(req('GET'), ctx)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.locale).toBe('es')
    expect(json.isOverride).toBe(false)
  })
})

describe('PATCH /api/routes-b/invoices/[id]/locale (#1118)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 for unsupported locale', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue({ id: 'inv-1' })
    const { PATCH } = await import('./route')
    const res = await PATCH(req('PATCH', { locale: 'xx' }), ctx)
    expect(res.status).toBe(400)
  })

  it('returns 400 when no fields provided', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue({ id: 'inv-1' })
    const { PATCH } = await import('./route')
    const res = await PATCH(req('PATCH', {}), ctx)
    expect(res.status).toBe(400)
  })

  it('updates invoice locale override', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue({ id: 'inv-1' })
    invoiceLocaleUpsert.mockResolvedValue({
      locale: 'de', dateFormat: 'DD.MM.YYYY', numberFormat: null,
    })

    const { PATCH } = await import('./route')
    const res = await PATCH(req('PATCH', { locale: 'de', dateFormat: 'DD.MM.YYYY' }), ctx)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.locale).toBe('de')
    expect(json.isOverride).toBe(true)
    expect(invoiceLocaleUpsert).toHaveBeenCalled()
  })
})
