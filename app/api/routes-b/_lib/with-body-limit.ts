import { NextRequest, NextResponse } from 'next/server'

const ONE_MEBIBYTE = 1024 * 1024

type HandlerArgs = [NextRequest, ...unknown[]]
type Handler = (...args: HandlerArgs) => Promise<Response>

export type BodyLimitOptions = {
  limitBytes?: number
}

async function exceedsBodyLimit(request: NextRequest, limitBytes: number): Promise<boolean> {
  const contentLengthHeader = request.headers.get('content-length')

  if (contentLengthHeader) {
    const parsed = Number.parseInt(contentLengthHeader, 10)
    if (!Number.isNaN(parsed)) {
      return parsed > limitBytes
    }
  }

  if (!request.body) {
    return false
  }

  const clone = request.clone()
  const reader = clone.body?.getReader()
  if (!reader) {
    return false
  }

  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    total += value.byteLength
    if (total > limitBytes) {
      await reader.cancel()
      return true
    }
  }

  return false
}

export function withBodyLimit(handler: Handler, options?: BodyLimitOptions): Handler {
  const limitBytes = options?.limitBytes ?? ONE_MEBIBYTE

  return async (...args: HandlerArgs) => {
    const [request] = args

    const tooLarge = await exceedsBodyLimit(request, limitBytes)
    if (tooLarge) {
      return NextResponse.json(
        { error: `Payload too large. Maximum allowed is ${limitBytes} bytes` },
        { status: 413 },
      )
    }

    return handler(...args)
  }
}
