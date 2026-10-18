import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { encrypt } from '@/lib/crypto'
import { logger } from '@/lib/logger'

export const EXPORT_URL_TTL_SECONDS = 900 // 15 minutes

export const USER_OWNED_TABLE_SOURCES = [
  { key: 'wallet', delegate: 'wallet', mode: 'single' },
  { key: 'virtualAccount', delegate: 'virtualAccount', mode: 'single' },
  { key: 'kycApplication', delegate: 'kycApplication', mode: 'single' },
  { key: 'bankAccounts', delegate: 'bankAccount', mode: 'many' },
  { key: 'contacts', delegate: 'contact', mode: 'many' },
  { key: 'invoices', delegate: 'invoice', mode: 'many' },
  { key: 'transactions', delegate: 'transaction', mode: 'many' },
  { key: 'withdrawalTransactions', delegate: 'withdrawalTransaction', mode: 'many' },
  { key: 'expenses', delegate: 'expense', mode: 'many' },
  { key: 'subscriptions', delegate: 'subscription', mode: 'many' },
  { key: 'timeEntries', delegate: 'timeEntry', mode: 'many' },
  { key: 'savingsGoals', delegate: 'savingsGoal', mode: 'many' },
  { key: 'kycDocuments', delegate: 'kycDocument', mode: 'many' },
  { key: 'notifications', delegate: 'notification', mode: 'many' },
  { key: 'apiKeys', delegate: 'apiKey', mode: 'many' },
  { key: 'webhooks', delegate: 'userWebhook', mode: 'many' },
  { key: 'creditNotes', delegate: 'creditNote', mode: 'many' },
  { key: 'refunds', delegate: 'refund', mode: 'many' },
  { key: 'quotes', delegate: 'quote', mode: 'many' },
  { key: 'projects', delegate: 'project', mode: 'many' },
] as const

export interface EncryptedArchiveRecord {
  exportId: string
  userId: string
  requestedByAdminId: string
  ticketReference: string
  encryptedPayload: string
  encryptionAlgorithm: string
  archiveSha256: string
  includedTables: string[]
  omittedTables: string[]
  totalRows: number
  createdAt: string
  expiresAt: string
}

const encryptedExportStore = new Map<string, EncryptedArchiveRecord>()

export function getEncryptedExportFromStore(
  exportId: string,
): EncryptedArchiveRecord | undefined {
  return encryptedExportStore.get(exportId)
}

async function requireAdminActor(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, admin: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, admin: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, admin: null }
  }

  let adminId = claims.userId
  let adminEmail = (claims as { email?: string | null }).email ?? null
  let role = (claims as { role?: string | null }).role ?? null

  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser =
      (await prisma.user.findUnique({
        where: { privyId: claims.userId },
        select: { id: true, email: true, role: true },
      })) ??
      (await prisma.user.findUnique({
        where: { id: claims.userId },
        select: { id: true, email: true, role: true },
      }))

    if (dbUser) {
      adminId = dbUser.id
      adminEmail = dbUser.email ?? adminEmail
      role = dbUser.role ?? role
    }
  }

  const normalizedRole = (role ?? '').toLowerCase()
  if (
    normalizedRole !== 'admin' &&
    normalizedRole !== 'super_admin' &&
    normalizedRole !== 'compliance_admin'
  ) {
    return {
      error: 'Forbidden: Admin access required',
      status: 403 as const,
      admin: null,
    }
  }

  return {
    error: null,
    status: 200 as const,
    admin: { id: adminId, email: adminEmail, role: normalizedRole },
  }
}

function sanitizeRecord(
  tableKey: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const clone = { ...row }
  if (tableKey === 'apiKeys') {
    delete clone.hashedKey
  }
  if (tableKey === 'webhooks') {
    delete clone.signingSecret
    delete clone.previousSigningSecret
  }
  return clone
}

function signDownloadUrl(
  exportId: string,
  userId: string,
  expiresUnix: number,
): string {
  const secret =
    process.env.EXPORT_SIGNING_SECRET ||
    process.env.ENCRYPTION_KEY ||
    'default-export-signing-secret'
  const payload = `${exportId}:${userId}:${expiresUnix}`
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex')
  return `https://api.lancepay.io/api/admin/data-exports/${encodeURIComponent(
    userId,
  )}/download?exportId=${encodeURIComponent(
    exportId,
  )}&expires=${expiresUnix}&sig=${sig}`
}

/**
 * POST /api/admin/data-exports/[userId]
 * Packages a GDPR-style data export for a user:
 * - Collects rows from every user-owned table and omits tables where the user has no ownership.
 * - Encrypts the resulting archive at rest (AES-256-CBC) and returns a short-lived signed download URL
 *   rather than raw archive bytes.
 * - Records the export request on the data export ledger with the originating ticket reference.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ userId: string }> | { userId: string } },
) {
  try {
    const auth = await requireAdminActor(req)
    if (auth.error || !auth.admin) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const resolvedParams = await Promise.resolve(context.params)
    const userId = resolvedParams?.userId?.trim() || ''
    if (!userId) {
      return NextResponse.json(
        { error: 'userId route parameter is required' },
        { status: 400 },
      )
    }

    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const ticketReference =
      (typeof body.ticketReference === 'string' && body.ticketReference.trim()) ||
      (typeof body.ticketRef === 'string' && body.ticketRef.trim()) ||
      (typeof body.ticketId === 'string' && body.ticketId.trim()) ||
      ''

    if (!ticketReference || ticketReference.length < 3) {
      return NextResponse.json(
        {
          error: 'ticketReference is required for GDPR data export auditability',
          code: 'TICKET_REFERENCE_REQUIRED',
        },
        { status: 400 },
      )
    }

    const reason =
      typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : 'GDPR Subject Access Request'

    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
    })

    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const safeProfile: Record<string, unknown> = { ...targetUser }
    delete safeProfile.twoFactorSecret
    delete safeProfile.backupCodes

    const db = prisma as unknown as Record<
      string,
      | {
          findUnique?: (args: unknown) => Promise<Record<string, unknown> | null>
          findMany?: (args: unknown) => Promise<Record<string, unknown>[]>
        }
      | undefined
    >

    const exportedTables: Record<string, Record<string, unknown>[]> = {}
    const includedTables: string[] = []
    const omittedTables: string[] = []
    let totalRows = 0

    for (const source of USER_OWNED_TABLE_SOURCES) {
      const delegate = db[source.delegate]
      if (!delegate) {
        omittedTables.push(source.key)
        continue
      }

      let rows: Record<string, unknown>[] = []
      if (source.mode === 'single' && typeof delegate.findUnique === 'function') {
        const single = await delegate.findUnique({ where: { userId } })
        if (single && (!('userId' in single) || single.userId === userId)) {
          rows = [sanitizeRecord(source.key, single)]
        }
      } else if (typeof delegate.findMany === 'function') {
        const list = await delegate.findMany({ where: { userId } })
        if (Array.isArray(list)) {
          rows = list
            .filter((r) => !('userId' in r) || r.userId === userId)
            .map((r) => sanitizeRecord(source.key, r))
        }
      }

      if (rows.length > 0) {
        exportedTables[source.key] = rows
        includedTables.push(source.key)
        totalRows += rows.length
      } else {
        omittedTables.push(source.key)
      }
    }

    const now = new Date()
    const expiresUnix = Math.floor(now.getTime() / 1000) + EXPORT_URL_TTL_SECONDS
    const expiresAt = new Date(expiresUnix * 1000).toISOString()
    const exportId = `exp_${crypto.randomBytes(12).toString('hex')}`

    const archivePlaintext = JSON.stringify({
      schemaVersion: '1.0',
      exportId,
      exportedAt: now.toISOString(),
      userId,
      ticketReference,
      reason,
      profile: safeProfile,
      tables: exportedTables,
    })

    const archiveSha256 = crypto
      .createHash('sha256')
      .update(archivePlaintext)
      .digest('hex')
    const encryptedPayload = encrypt(archivePlaintext)

    const archiveRecord: EncryptedArchiveRecord = {
      exportId,
      userId,
      requestedByAdminId: auth.admin.id,
      ticketReference,
      encryptedPayload,
      encryptionAlgorithm: 'aes-256-cbc',
      archiveSha256,
      includedTables,
      omittedTables,
      totalRows,
      createdAt: now.toISOString(),
      expiresAt,
    }

    encryptedExportStore.set(exportId, archiveRecord)

    const ledgerDb = prisma as unknown as {
      dataExportLedger?: {
        create: (args: unknown) => Promise<Record<string, unknown>>
      }
      auditLog?: {
        create: (args: unknown) => Promise<Record<string, unknown>>
      }
    }

    const ledgerEntry =
      (await ledgerDb.dataExportLedger?.create({
        data: {
          id: exportId,
          userId,
          requestedByAdminId: auth.admin.id,
          ticketReference,
          reason,
          includedTables,
          omittedTables,
          totalRows,
          archiveSha256,
          encryptedPayload,
          encryptionAlgorithm: 'aes-256-cbc',
          status: 'ready',
          expiresAt: new Date(expiresAt),
        },
      })) ?? {
        id: exportId,
        userId,
        requestedByAdminId: auth.admin.id,
        ticketReference,
        reason,
        includedTables,
        omittedTables,
        totalRows,
        archiveSha256,
        encryptionAlgorithm: 'aes-256-cbc',
        status: 'ready',
        createdAt: now.toISOString(),
        expiresAt,
      }

    await ledgerDb.auditLog?.create({
      data: {
        actorId: auth.admin.id,
        actorEmail: auth.admin.email,
        action: 'admin.data_export.created',
        resourceType: 'DataExport',
        resourceId: exportId,
        metadata: {
          userId,
          ticketReference,
          reason,
          includedTables,
          omittedTables,
          totalRows,
          archiveSha256,
        },
      },
    })

    const downloadUrl = signDownloadUrl(exportId, userId, expiresUnix)

    logger?.info?.(
      {
        exportId,
        userId,
        adminId: auth.admin.id,
        ticketReference,
        includedTableCount: includedTables.length,
        totalRows,
      },
      'POST /api/admin/data-exports/[userId] packaged encrypted GDPR export',
    )

    return NextResponse.json(
      {
        exportId,
        userId,
        ticketReference,
        reason,
        status: 'ready',
        encryption: {
          algorithm: 'aes-256-cbc',
          atRest: true,
          archiveSha256,
        },
        includedTables,
        omittedTables,
        totalRows,
        downloadUrl,
        ttlSeconds: EXPORT_URL_TTL_SECONDS,
        expiresAt,
        ledgerEntry: {
          id: ledgerEntry.id ?? exportId,
          ticketReference,
          requestedByAdminId: auth.admin.id,
          status: 'ready',
          createdAt: now.toISOString(),
          expiresAt,
        },
      },
      { status: 201 },
    )
  } catch (err) {
    logger?.error?.({ err }, 'POST /api/admin/data-exports/[userId] error')
    return NextResponse.json(
      { error: 'Failed to package user data export' },
      { status: 500 },
    )
  }
}
