import { describe, expect, it } from 'vitest'
import { gunzipSync, brotliDecompressSync } from 'zlib'
import { NextRequest, NextResponse } from 'next/server'
import { withCompression } from '../_lib/with-compression'

const BIG_PAYLOAD = JSON.stringify({ data: 'x'.repeat(2048) })
const SMALL_PAYLOAD = JSON.stringify({ ok: true })

function makeRequest(acceptEncoding: string) {
  return new NextRequest('http://localhost/test', {
    headers: { 'accept-encoding': acceptEncoding },
  })
}

function makeResponse(body: string, status = 200) {
  return NextResponse.json(JSON.parse(body), { status })
}

describe('withCompression', () => {
  it('compresses with gzip when Accept-Encoding includes gzip', async () => {
    const req = makeRequest('gzip')
    const res = await withCompression(req, makeResponse(BIG_PAYLOAD))
    expect(res.headers.get('content-encoding')).toBe('gzip')
    const buf = Buffer.from(await res.arrayBuffer())
    const decompressed = gunzipSync(buf).toString()
    expect(JSON.parse(decompressed).data).toBe('x'.repeat(2048))
  })

  it('compresses with br when Accept-Encoding includes br', async () => {
    const req = makeRequest('br')
    const res = await withCompression(req, makeResponse(BIG_PAYLOAD))
    expect(res.headers.get('content-encoding')).toBe('br')
    const buf = Buffer.from(await res.arrayBuffer())
    const decompressed = brotliDecompressSync(buf).toString()
    expect(JSON.parse(decompressed).data).toBe('x'.repeat(2048))
  })

  it('prefers br over gzip when both accepted', async () => {
    const req = makeRequest('gzip, br')
    const res = await withCompression(req, makeResponse(BIG_PAYLOAD))
    expect(res.headers.get('content-encoding')).toBe('br')
  })

  it('falls back to identity when no supported encoding in Accept-Encoding', async () => {
    const req = makeRequest('deflate, zstd')
    const res = await withCompression(req, makeResponse(BIG_PAYLOAD))
    expect(res.headers.get('content-encoding')).toBeNull()
    const text = await res.text()
    expect(JSON.parse(text).data).toBe('x'.repeat(2048))
  })

  it('skips compression for small bodies (< 1 KiB) even when gzip requested', async () => {
    const req = makeRequest('gzip')
    const res = await withCompression(req, makeResponse(SMALL_PAYLOAD))
    expect(res.headers.get('content-encoding')).toBeNull()
  })

  it('skips compression when Accept-Encoding is absent', async () => {
    const req = new NextRequest('http://localhost/test')
    const res = await withCompression(req, makeResponse(BIG_PAYLOAD))
    expect(res.headers.get('content-encoding')).toBeNull()
  })

  it('preserves the original HTTP status code', async () => {
    const req = makeRequest('gzip')
    const res = await withCompression(req, NextResponse.json({ error: 'not found' }, { status: 404 }))
    expect(res.status).toBe(404)
  })

  it('removes Content-Length header after compression', async () => {
    const req = makeRequest('gzip')
    const source = makeResponse(BIG_PAYLOAD)
    const res = await withCompression(req, source)
    if (res.headers.get('content-encoding')) {
      expect(res.headers.get('content-length')).toBeNull()
    }
  })

  it('preserves other response headers', async () => {
    const req = makeRequest('gzip')
    const source = NextResponse.json(JSON.parse(BIG_PAYLOAD), {
      headers: { 'X-Cache': 'HIT' },
    })
    const res = await withCompression(req, source)
    expect(res.headers.get('x-cache')).toBe('HIT')
  })
})
