import { createHmac } from 'crypto'
import { prisma } from '@/lib/db'

const AUDIT_SECRET = process.env.AUDIT_SECRET || 'default-audit-secret-change-in-production'

interface AuditMetadata {
  ip?: string
  userAgent?: string
  [key: string]: unknown
}

export function generateSignature(
  invoiceId: string,
  eventType: string,
  timestamp: string,
  metadata: AuditMetadata | null
): string {
  const payload = `${invoiceId}:${eventType}:${timestamp}:${JSON.stringify(metadata || {})}`
  return createHmac('sha256', AUDIT_SECRET).update(payload).digest('hex')
}

export function verifySignature(
  invoiceId: string,
  eventType: string,
  timestamp: string,
  metadata: AuditMetadata | null,
  signature: string
): boolean {
  const expected = generateSignature(invoiceId, eventType, timestamp, metadata)
  return expected === signature
}

export async function logAuditEvent(
  invoiceId: string,
  eventType: string,
  actorId: string | null,
  metadata: AuditMetadata | null
) {
  const timestamp = new Date().toISOString()
  const signature = generateSignature(invoiceId, eventType, timestamp, metadata)

  return prisma.auditEvent.create({
    data: {
      invoiceId,
      eventType,
      actorId,
      metadata,
      signature,
    },
  })
}

export function maskSensitiveData(metadata: AuditMetadata | null): AuditMetadata | null {
  if (!metadata) return null

  const masked = { ...metadata }
  if (masked.ip) {
    const parts = masked.ip.split('.')
    if (parts.length === 4) {
      masked.ip = `${parts[0]}.${parts[1]}.***.***`
    }
  }
  return masked
}

export function extractRequestMetadata(headers: Headers): AuditMetadata {
  return {
    ip: headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip') || undefined,
    userAgent: headers.get('user-agent') || undefined,
  }
}
