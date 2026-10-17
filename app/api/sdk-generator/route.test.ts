import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    sdkBundle: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}))

import {
  POST,
  clearSdkBundleCache,
  computeLiveSpecRevision,
  computeSdkBundleHash,
} from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const actor = { id: 'user-sdk-1', email: 'dev@lancepay.io' }
const NOW = new Date('2026-10-17T12:00:00.000Z')

function makeRequest(body?: unknown, raw?: string): NextRequest {
  return new NextRequest('http://localhost/api/sdk-generator', {
    method: 'POST',
    headers: { authorization: 'Bearer valid-token' },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  })
}

describe('POST /api/sdk-generator (#1571)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearSdkBundleCache()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(actor as any)
    vi.mocked((prisma as any).sdkBundle.findUnique).mockResolvedValue(null)
    vi.mocked((prisma as any).sdkBundle.create).mockResolvedValue({} as any)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('builds a typed SDK bundle for a chosen language, caches by SHA-256(language, apiVersion, specRevision), and returns a short-lived signed downloadUrl without inlining bundle files', async () => {
    const res = await POST(makeRequest({ language: 'typescript', apiVersion: '2026-06-01' }))

    expect(res.status).toBe(201)
    const body = await res.json()

    const { specRevision } = computeLiveSpecRevision('2026-06-01')
    const expectedHash = computeSdkBundleHash('typescript', '2026-06-01', specRevision)

    expect(body.bundleHash).toBe(expectedHash)
    expect(body.language).toBe('typescript')
    expect(body.apiVersion).toBe('2026-06-01')
    expect(body.specRevision).toBe(specRevision)
    expect(body.cached).toBe(false)
    expect(body.fileCount).toBe(3)
    expect(body.sizeBytes).toBeGreaterThan(100)
    expect(body.downloadUrl).toMatch(
      new RegExp(
        `^https://cdn\\.lancepay\\.io/sdk-bundles/${expectedHash}/lancepay-typescript-sdk-2026-06-01\\.tar\\.gz\\?expires=\\d+&sig=[0-9a-f]{64}$`
      )
    )
    expect(body.expiresAt).toBe(new Date(NOW.getTime() + 15 * 60 * 1000).toISOString())
    // Must not inline bundle files in response payload
    expect(body.files).toBeUndefined()
    expect(body.bundle).toBeUndefined()
  })

  it('returns cached=true on subsequent requests for the same (language, apiVersion, specRevision) without rebuilding', async () => {
    const first = await POST(makeRequest({ language: 'python', apiVersion: '2026-06-01' }))
    expect(first.status).toBe(201)
    expect((await first.json()).cached).toBe(false)
    expect((prisma as any).sdkBundle.create).toHaveBeenCalledTimes(1)

    const second = await POST(makeRequest({ language: 'python', apiVersion: '2026-06-01' }))
    expect(second.status).toBe(200)
    const secondBody = await second.json()
    expect(secondBody.cached).toBe(true)
    expect((prisma as any).sdkBundle.create).toHaveBeenCalledTimes(1)
  })

  it('produces distinct bundleHashes across different languages or API versions', async () => {
    const tsRes = await POST(makeRequest({ language: 'typescript', apiVersion: '2026-06-01' }))
    const goRes = await POST(makeRequest({ language: 'go', apiVersion: '2026-06-01' }))
    const oldVerRes = await POST(makeRequest({ language: 'typescript', apiVersion: '2025-05-01' }))

    const tsBody = await tsRes.json()
    const goBody = await goRes.json()
    const oldVerBody = await oldVerRes.json()

    expect(tsBody.bundleHash).not.toBe(goBody.bundleHash)
    expect(tsBody.bundleHash).not.toBe(oldVerBody.bundleHash)
  })

  it('rejects unsupported languages or unsupported API versions with 400', async () => {
    const badLang = await POST(makeRequest({ language: 'cobol' }))
    expect(badLang.status).toBe(400)

    const badVer = await POST(makeRequest({ language: 'rust', apiVersion: '2020-01-01' }))
    expect(badVer.status).toBe(400)
    expect((await badVer.json()).code).toBe('UNSUPPORTED_API_VERSION')
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    const res = await POST(makeRequest({ language: 'typescript' }))
    expect(res.status).toBe(401)
  })
})
