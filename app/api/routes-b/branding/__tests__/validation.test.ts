import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { PATCH } from '../route'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const upsert = vi.fn()
const hasTableColumn = vi.fn()
const executeRaw = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    brandingSettings: { upsert },
    $executeRaw: executeRaw,
  },
}))
vi.mock('../_lib/table-columns', () => ({
  hasTableColumn,
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
}))

const BASE_URL = 'http://localhost/api/routes-b/branding'

function makeRequest(body?: unknown) {
  return new NextRequest(BASE_URL, {
    method: 'PATCH',
    headers: { 
      authorization: 'Bearer token',
      'content-type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('PATCH /api/routes-b/branding validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    hasTableColumn.mockResolvedValue(false) // Disable optional columns by default
    upsert.mockResolvedValue({
      id: 'brand_1',
      userId: 'user_1',
      logoUrl: null,
      primaryColor: null,
      footerText: null,
      signatureUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  })

  it('returns 401 for unauthenticated requests', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const res = await PATCH(makeRequest({}))
    expect(res.status).toBe(401)
  })

  it('returns 422 for invalid JSON', async () => {
    const res = await PATCH(new NextRequest(BASE_URL, {
      method: 'PATCH',
      headers: { 
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: 'invalid json',
    }))
    
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.error.code).toBe('BAD_REQUEST')
    expect(data.error.fields.body).toBe('Invalid JSON')
  })

  it('validates hex color format', async () => {
    const res = await PATCH(makeRequest({ primaryColor: 'invalid-color' }))
    
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.error.code).toBe('BAD_REQUEST')
    expect(data.error.fields.primaryColor).toContain('Must be a valid 6-digit hex color')
  })

  it('accepts valid hex colors', async () => {
    const res = await PATCH(makeRequest({ primaryColor: '#FF5733' }))
    
    expect(res.status).toBe(200)
    expect(upsert).toHaveBeenCalledWith({
      where: { userId: 'user_1' },
      update: { primaryColor: '#FF5733' },
      create: { userId: 'user_1', primaryColor: '#FF5733' },
    })
  })

  it('validates HTTPS URLs for logoUrl', async () => {
    const res = await PATCH(makeRequest({ logoUrl: 'http://example.com/logo.png' }))
    
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.error.fields.logoUrl).toContain('Must use https')
  })

  it('accepts valid HTTPS URLs', async () => {
    const res = await PATCH(makeRequest({ logoUrl: 'https://example.com/logo.png' }))
    
    expect(res.status).toBe(200)
    expect(upsert).toHaveBeenCalledWith({
      where: { userId: 'user_1' },
      update: { logoUrl: 'https://example.com/logo.png' },
      create: { userId: 'user_1', logoUrl: 'https://example.com/logo.png' },
    })
  })

  it('accepts null values for optional fields', async () => {
    const res = await PATCH(makeRequest({ logoUrl: null, footerText: null }))
    
    expect(res.status).toBe(200)
    expect(upsert).toHaveBeenCalledWith({
      where: { userId: 'user_1' },
      update: { logoUrl: null, footerText: null },
      create: { userId: 'user_1', logoUrl: null, footerText: null },
    })
  })

  it('validates footer text length', async () => {
    const longText = 'a'.repeat(201)
    const res = await PATCH(makeRequest({ footerText: longText }))
    
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.error.fields.footerText).toContain('Must be 200 characters or fewer')
  })

  it('validates domain format for customDomain', async () => {
    hasTableColumn.mockImplementation((table, column) => column === 'customDomain')
    
    const res = await PATCH(makeRequest({ customDomain: 'invalid..domain' }))
    
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.error.fields.customDomain).toContain('Must be a valid domain name')
  })

  it('accepts valid domain names', async () => {
    hasTableColumn.mockImplementation((table, column) => column === 'customDomain')
    
    const res = await PATCH(makeRequest({ customDomain: 'example.com' }))
    
    expect(res.status).toBe(200)
    expect(executeRaw).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "BrandingSettings"'),
      'example.com',
      'user_1'
    )
  })

  it('strips unknown fields from request', async () => {
    const res = await PATCH(makeRequest({ 
      primaryColor: '#FF5733',
      unknownField: 'should be stripped',
    }))
    
    expect(res.status).toBe(200)
    expect(upsert).toHaveBeenCalledWith({
      where: { userId: 'user_1' },
      update: { primaryColor: '#FF5733' },
      create: { userId: 'user_1', primaryColor: '#FF5733' },
    })
  })

  it('handles multiple validation errors', async () => {
    const res = await PATCH(makeRequest({ 
      primaryColor: 'invalid',
      logoUrl: 'http://insecure.com',
      footerText: 'a'.repeat(201),
    }))
    
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.error.fields.primaryColor).toBeDefined()
    expect(data.error.fields.logoUrl).toBeDefined()
    expect(data.error.fields.footerText).toBeDefined()
  })

  it('returns 500 on database error', async () => {
    upsert.mockRejectedValue(new Error('Database error'))
    
    const res = await PATCH(makeRequest({ primaryColor: '#FF5733' }))
    
    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error.code).toBe('INTERNAL')
  })
})