import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { prismaMock, verifyAuthTokenMock } = vi.hoisted(() => {
  const prismaMock = { user: { findUnique: vi.fn() } }
  const verifyAuthTokenMock = vi.fn()
  return { prismaMock, verifyAuthTokenMock }
})

vi.mock('@/lib/auth', () => ({ verifyAuthToken: verifyAuthTokenMock }))
vi.mock('@/lib/db', () => ({ prisma: prismaMock }))

import {
  clearWidgetStore,
  DEFAULT_ORDER,
  getWidgetConfig,
  patchWidgetConfig,
  WIDGET_CATALOG,
} from '../_lib/dashboard-widgets'
import { GET, PATCH } from '../dashboard/widgets/route'

// ── Unit tests for the dashboard-widgets lib ─────────────────────────

describe('dashboard-widgets lib', () => {
  beforeEach(() => {
    clearWidgetStore()
  })

  describe('getWidgetConfig — defaults', () => {
    it('returns all widgets in default order when no config saved', () => {
      const config = getWidgetConfig('user-1')
      expect(config.order).toEqual(DEFAULT_ORDER)
      expect(config.hidden).toEqual([])
    })

    it('default order matches catalog defaultOrder field', () => {
      const expected = WIDGET_CATALOG.slice()
        .sort((a, b) => a.defaultOrder - b.defaultOrder)
        .map(w => w.id)
      expect(DEFAULT_ORDER).toEqual(expected)
    })

    it('appends missing widgets after saved order in default order', () => {
      patchWidgetConfig('user-1', { order: ['invoices', 'earnings'] })
      const config = getWidgetConfig('user-1')
      expect(config.order.slice(0, 2)).toEqual(['invoices', 'earnings'])
      const remaining = config.order.slice(2)
      const expectedRemaining = DEFAULT_ORDER.filter(
        id => id !== 'invoices' && id !== 'earnings',
      )
      expect(remaining).toEqual(expectedRemaining)
    })
  })

  describe('patchWidgetConfig', () => {
    it('updates order', () => {
      const result = patchWidgetConfig('user-1', {
        order: ['clients', 'invoices', 'earnings', 'transactions', 'pending-withdrawals', 'trust-score'],
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error()
      expect(result.config.order[0]).toBe('clients')
      expect(result.config.order[1]).toBe('invoices')
    })

    it('updates hidden', () => {
      const result = patchWidgetConfig('user-1', { hidden: ['trust-score'] })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error()
      expect(result.config.hidden).toContain('trust-score')
    })

    it('partial update: only order changes, hidden preserved', () => {
      patchWidgetConfig('user-1', { hidden: ['earnings'] })
      const result = patchWidgetConfig('user-1', { order: ['clients', 'invoices'] })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error()
      expect(result.config.hidden).toContain('earnings')
    })

    it('partial update: only hidden changes, order preserved', () => {
      patchWidgetConfig('user-1', { order: ['clients', 'invoices'] })
      const result = patchWidgetConfig('user-1', { hidden: ['trust-score'] })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error()
      expect(result.config.order[0]).toBe('clients')
    })

    it('rejects unknown widget id in order', () => {
      const result = patchWidgetConfig('user-1', { order: ['invoices', 'unknown-widget'] })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error()
      expect(result.unknownIds).toContain('unknown-widget')
    })

    it('rejects unknown widget id in hidden', () => {
      const result = patchWidgetConfig('user-1', { hidden: ['no-such-widget'] })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error()
      expect(result.unknownIds).toContain('no-such-widget')
    })

    it('deduplicates order array', () => {
      const result = patchWidgetConfig('user-1', {
        order: ['invoices', 'invoices', 'clients', 'clients'],
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error()
      const order = result.config.order
      expect(order.indexOf('invoices')).toBe(order.lastIndexOf('invoices'))
      expect(order.indexOf('clients')).toBe(order.lastIndexOf('clients'))
    })

    it('deduplicates hidden array', () => {
      const result = patchWidgetConfig('user-1', {
        hidden: ['invoices', 'invoices'],
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error()
      const hidden = result.config.hidden
      expect(hidden.filter(id => id === 'invoices').length).toBe(1)
    })

    it('isolates configs between users', () => {
      patchWidgetConfig('user-1', { order: ['clients', 'invoices'] })
      patchWidgetConfig('user-2', { hidden: ['earnings'] })

      const c1 = getWidgetConfig('user-1')
      const c2 = getWidgetConfig('user-2')
      expect(c1.order[0]).toBe('clients')
      expect(c1.hidden).toEqual([])
      expect(c2.hidden).toContain('earnings')
    })
  })
})

// ── Route handler integration tests ──────────────────────────────────

describe('GET /dashboard/widgets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearWidgetStore()
    verifyAuthTokenMock.mockResolvedValue({ userId: 'privy-1' })
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1' })
  })

  it('returns 401 when no token', async () => {
    const req = new NextRequest('http://localhost/api/routes-b/dashboard/widgets')
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('returns 401 when token invalid', async () => {
    verifyAuthTokenMock.mockResolvedValue(null)
    const req = new NextRequest('http://localhost/api/routes-b/dashboard/widgets', {
      headers: { authorization: 'Bearer bad' },
    })
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('returns default config for new user', async () => {
    const req = new NextRequest('http://localhost/api/routes-b/dashboard/widgets', {
      headers: { authorization: 'Bearer tok' },
    })
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.widgets.order).toEqual(DEFAULT_ORDER)
    expect(body.widgets.hidden).toEqual([])
  })
})

describe('PATCH /dashboard/widgets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearWidgetStore()
    verifyAuthTokenMock.mockResolvedValue({ userId: 'privy-1' })
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1' })
  })

  it('returns 400 when body is empty', async () => {
    const req = new NextRequest('http://localhost/api/routes-b/dashboard/widgets', {
      method: 'PATCH',
      headers: { authorization: 'Bearer tok' },
      body: JSON.stringify({}),
    })
    const res = await PATCH(req)
    expect(res.status).toBe(400)
  })

  it('updates order successfully', async () => {
    const newOrder = ['clients', 'invoices', 'earnings', 'transactions', 'pending-withdrawals', 'trust-score']
    const req = new NextRequest('http://localhost/api/routes-b/dashboard/widgets', {
      method: 'PATCH',
      headers: { authorization: 'Bearer tok' },
      body: JSON.stringify({ order: newOrder }),
    })
    const res = await PATCH(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.widgets.order[0]).toBe('clients')
  })

  it('rejects unknown widget id with 422', async () => {
    const req = new NextRequest('http://localhost/api/routes-b/dashboard/widgets', {
      method: 'PATCH',
      headers: { authorization: 'Bearer tok' },
      body: JSON.stringify({ order: ['invoices', 'bad-widget'] }),
    })
    const res = await PATCH(req)
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.unknownIds).toContain('bad-widget')
  })

  it('deduplicates order in response', async () => {
    const req = new NextRequest('http://localhost/api/routes-b/dashboard/widgets', {
      method: 'PATCH',
      headers: { authorization: 'Bearer tok' },
      body: JSON.stringify({ order: ['invoices', 'invoices', 'clients'] }),
    })
    const res = await PATCH(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.widgets.order.filter((id: string) => id === 'invoices').length).toBe(1)
  })

  it('missing widgets append in default order after partial order update', async () => {
    const req = new NextRequest('http://localhost/api/routes-b/dashboard/widgets', {
      method: 'PATCH',
      headers: { authorization: 'Bearer tok' },
      body: JSON.stringify({ order: ['earnings'] }),
    })
    const res = await PATCH(req)
    const body = await res.json()
    expect(body.widgets.order[0]).toBe('earnings')
    expect(body.widgets.order.length).toBe(DEFAULT_ORDER.length)
    const tail = body.widgets.order.slice(1)
    const expectedTail = DEFAULT_ORDER.filter(id => id !== 'earnings')
    expect(tail).toEqual(expectedTail)
  })
})
