import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import fs from 'fs'
import { GET, filterPublicSchema, computeSchemaHash } from './route'

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

describe('GET /api/graphql/schema', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    delete process.env.GRAPHQL_SCHEMA_PATH
  })

  function makeRequest(url = 'http://localhost:3000/api/graphql/schema', headers: Record<string, string> = {}) {
    return new NextRequest(url, {
      method: 'GET',
      headers,
    })
  }

  const sampleRawSdl = `
directive @internal on FIELD_DEFINITION | OBJECT
directive @private on FIELD_DEFINITION | OBJECT

type User {
  id: ID!
  email: String!
  privyId: String @internal
  hashedKey: String @private
}

type InternalAudit @internal {
  secretId: String!
}

type Query {
  user: User
  auditLog: InternalAudit @internal
}
`

  it('filters out private and internal types and fields from the public SDL', () => {
    const publicSdl = filterPublicSchema(sampleRawSdl)

    expect(publicSdl).toContain('type User')
    expect(publicSdl).toContain('id: ID!')
    expect(publicSdl).toContain('email: String!')
    expect(publicSdl).not.toContain('privyId')
    expect(publicSdl).not.toContain('hashedKey')
    expect(publicSdl).not.toContain('type InternalAudit')
    expect(publicSdl).not.toContain('auditLog: InternalAudit')
    expect(publicSdl).not.toContain('directive @internal')
    expect(publicSdl).not.toContain('directive @private')
  })

  it('serves filtered public GraphQL SDL with long cache headers and ETag', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.spyOn(fs, 'readFileSync').mockReturnValue(sampleRawSdl)

    const req = makeRequest()
    const res = await GET(req)
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')

    const expectedHash = computeSchemaHash(filterPublicSchema(sampleRawSdl))
    expect(res.headers.get('etag')).toBe(`"${expectedHash}"`)
    expect(body).not.toContain('privyId')
    expect(body).not.toContain('InternalAudit')
  })

  it('returns 304 Not Modified when If-None-Match matches schema hash', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.spyOn(fs, 'readFileSync').mockReturnValue(sampleRawSdl)

    const expectedHash = computeSchemaHash(filterPublicSchema(sampleRawSdl))
    const req = makeRequest('http://localhost:3000/api/graphql/schema', {
      'if-none-match': `"${expectedHash}"`,
    })

    const res = await GET(req)
    expect(res.status).toBe(304)
    expect(res.headers.get('etag')).toBe(`"${expectedHash}"`)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it('returns JSON format when requested via query param or accept header', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.spyOn(fs, 'readFileSync').mockReturnValue(sampleRawSdl)

    const req = makeRequest('http://localhost:3000/api/graphql/schema?format=json')
    const res = await GET(req)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.schema).toBeDefined()
    expect(json.hash).toBeDefined()
    expect(json.schema).not.toContain('InternalAudit')
  })

  it('fails closed with 503 when the schema file is missing', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)

    const req = makeRequest()
    const res = await GET(req)
    const json = await res.json()

    expect(res.status).toBe(503)
    expect(json.code).toBe('SCHEMA_FILE_MISSING')
  })

  it('returns 500 when reading schema file encounters an I/O error', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })

    const req = makeRequest()
    const res = await GET(req)
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.code).toBe('SCHEMA_READ_ERROR')
  })
})
