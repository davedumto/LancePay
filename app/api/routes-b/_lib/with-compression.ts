import { gzipSync, brotliCompressSync } from 'zlib'
import { NextRequest, NextResponse } from 'next/server'

const MIN_COMPRESS_BYTES = 1024

/**
 * Wrap a NextResponse with content negotiation for gzip or brotli compression.
 *
 * - Reads Accept-Encoding from the request header.
 * - Skips compression when the response body is smaller than MIN_COMPRESS_BYTES (1 KiB).
 * - Returns a plain Response (compatible with Next.js route handler return types).
 * - Does NOT compress streaming/chunked responses — call only for buffered JSON/text.
 *
 * Preference order: br > gzip > identity.
 */
export async function withCompression(
  request: NextRequest,
  response: NextResponse,
): Promise<Response> {
  const rawBody = await response.arrayBuffer()
  const body = Buffer.from(rawBody)

  const copyHeaders = new Headers(response.headers)

  if (body.length < MIN_COMPRESS_BYTES) {
    return new Response(body, { status: response.status, headers: copyHeaders })
  }

  const acceptEncoding = request.headers.get('accept-encoding') ?? ''

  let compressed: Buffer | null = null
  let encoding: string | null = null

  if (acceptEncoding.includes('br')) {
    compressed = brotliCompressSync(body)
    encoding = 'br'
  } else if (acceptEncoding.includes('gzip')) {
    compressed = gzipSync(body)
    encoding = 'gzip'
  }

  if (!compressed || !encoding) {
    return new Response(body, { status: response.status, headers: copyHeaders })
  }

  copyHeaders.set('Content-Encoding', encoding)
  copyHeaders.delete('Content-Length')

  return new Response(compressed, { status: response.status, headers: copyHeaders })
}
