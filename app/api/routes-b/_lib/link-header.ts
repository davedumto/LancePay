type CursorPayload = {
  createdAt: string
  id: string
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function buildLinkHeader(
  requestUrl: string,
  nextCursor: string | null
): string | null {
  if (!nextCursor) return null

  const url = new URL(requestUrl)
  url.searchParams.set('cursor', nextCursor)

  return `<${url.toString()}>; rel="next"`
}