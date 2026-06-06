type CursorPayload = {
  createdAt: string
  id: string
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    const parsed = JSON.parse(decoded) as CursorPayload

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.id !== 'string'
    ) {
      return null
    }

    const createdAt = new Date(parsed.createdAt)
    if (Number.isNaN(createdAt.getTime())) {
      return null
    }

    return { createdAt: createdAt.toISOString(), id: parsed.id }
  } catch {
    return null
  }
}

