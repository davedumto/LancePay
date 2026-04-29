import crypto from 'crypto'

export function createEntityEtag(id: string, updatedAt: Date) {
  const hash = crypto
    .createHash('sha256')
    .update(`${id}:${updatedAt.toISOString()}`)
    .digest('hex')
  return `"${hash}"`
}

export function ifMatchSatisfied(ifMatchHeader: string, etag: string) {
  return ifMatchHeader
    .split(',')
    .map(value => value.trim())
    .some(candidate => candidate === etag)
}

