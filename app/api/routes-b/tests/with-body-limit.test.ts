import { describe, expect, it } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { withBodyLimit } from '../_lib/with-body-limit'

const okHandler = async () => NextResponse.json({ ok: true })

describe('withBodyLimit', () => {
  it('allows under and at limit', async () => {
    const wrapped = withBodyLimit(okHandler, { limitBytes: 4 })

    const under = await wrapped(new NextRequest('http://localhost/x', { method: 'POST', headers: { 'content-length': '3' }, body: 'abc' }))
    const at = await wrapped(new NextRequest('http://localhost/x', { method: 'POST', headers: { 'content-length': '4' }, body: 'abcd' }))

    expect(under.status).toBe(200)
    expect(at.status).toBe(200)
  })

  it('rejects over limit and missing content-length stream over cap', async () => {
    const wrapped = withBodyLimit(okHandler, { limitBytes: 4 })

    const over = await wrapped(new NextRequest('http://localhost/x', { method: 'POST', headers: { 'content-length': '5' }, body: 'abcde' }))
    const missingLength = await wrapped(new NextRequest('http://localhost/x', { method: 'POST', body: 'abcde' }))

    expect(over.status).toBe(413)
    expect(missingLength.status).toBe(413)
  })

  it('supports per-route override', async () => {
    const wrapped = withBodyLimit(okHandler, { limitBytes: 2 })
    const res = await wrapped(new NextRequest('http://localhost/x', { method: 'POST', headers: { 'content-length': '3' }, body: 'abc' }))
    expect(res.status).toBe(413)
  })
})
