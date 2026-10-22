import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'
import { prisma } from '@/lib/db'

vi.mock('@/lib/db', () => ({
  prisma: {
    sdkBundle: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

describe('POST /api/sdk-generator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function makeRequest(body: unknown) {
    return new NextRequest('http://localhost:3000/api/sdk-generator', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  }

  it('produces a typed SDK bundle download URL from live OpenAPI spec', async () => {
    vi.mocked(prisma.sdkBundle.findUnique).mockResolvedValue(null)

    const now = new Date()
    const expiresAt = new Date(now.getTime() + 3600 * 1000)

    vi.mocked(prisma.sdkBundle.upsert).mockResolvedValue({
      id: 'sdk_ts_123',
      cacheKey: 'mock_cache_key',
      language: 'typescript',
      apiVersion: '2026-10-18',
      specRevision: 'spec_hash_abc',
      downloadUrl: '/api/sdk-generator/download/sdk_ts_123',
      fileSize: 25600,
      expiresAt,
      createdAt: now,
    })

    const req = makeRequest({ language: 'typescript' })
    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.cached).toBe(false)
    expect(json.language).toBe('typescript')
    expect(json.downloadUrl).toBe('/api/sdk-generator/download/sdk_ts_123')
    expect(json.specRevision).toBeDefined()
    expect(json.expiresAt).toBeDefined()
  })

  it('serves cached SDK bundle download link when cacheKey matches unexpired bundle', async () => {
    const expiresAt = new Date(Date.now() + 1800 * 1000)
    vi.mocked(prisma.sdkBundle.findUnique).mockResolvedValue({
      id: 'sdk_py_cached',
      cacheKey: 'key_python',
      language: 'python',
      apiVersion: '2026-10-18',
      specRevision: 'spec_hash_xyz',
      downloadUrl: '/api/sdk-generator/download/sdk_py_cached',
      fileSize: 32000,
      expiresAt,
      createdAt: new Date(),
    })

    const req = makeRequest({ language: 'python' })
    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.cached).toBe(true)
    expect(json.bundleId).toBe('sdk_py_cached')
    expect(prisma.sdkBundle.upsert).not.toHaveBeenCalled()
  })

  it('rejects unsupported languages with 400', async () => {
    const req = makeRequest({ language: 'cobol' })
    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.code).toBe('INVALID_SDK_REQUEST')
    expect(json.supportedLanguages).toContain('typescript')
    expect(json.supportedLanguages).toContain('python')
    expect(json.supportedLanguages).toContain('go')
  })

  it('rejects malformed JSON body with 400', async () => {
    const req = makeRequest('not-a-json-payload')
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 500 when database throws an error', async () => {
    vi.mocked(prisma.sdkBundle.findUnique).mockRejectedValue(new Error('DB failure'))

    const req = makeRequest({ language: 'go' })
    const res = await POST(req)
    expect(res.status).toBe(500)
  })
})
