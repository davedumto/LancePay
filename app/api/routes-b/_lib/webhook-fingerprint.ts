import { createHash } from 'crypto'

export function generateSecretFingerprint(secret: string): string {
  const hash = createHash('sha256').update(secret).digest('hex')
  return `${hash.slice(0, 4)}...${hash.slice(-4)}`
}
