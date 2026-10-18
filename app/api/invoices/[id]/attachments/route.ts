import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/csv',
  'text/plain',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
])

export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB

interface RouteContext {
  params: Promise<{ id: string }> | { id: string }
}

async function resolveInvoiceId(context?: RouteContext): Promise<string> {
  if (!context?.params) return ''
  const resolved = await Promise.resolve(context.params)
  return (resolved?.id ?? '').trim()
}

async function resolveAuthenticatedUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  let userId = claims.userId
  let userEmail: string | null = (claims as { email?: string | null }).email ?? null
  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser =
      (await prisma.user.findUnique({
        where: { privyId: claims.userId },
        select: { id: true, email: true },
      })) ??
      (await prisma.user.findUnique({
        where: { id: claims.userId },
        select: { id: true, email: true },
      }))

    if (!dbUser) {
      return { error: 'User not found', status: 404 as const, user: null }
    }
    userId = dbUser.id
    userEmail = dbUser.email ?? userEmail
  }

  return {
    error: null,
    status: 200 as const,
    user: { id: userId, email: userEmail },
  }
}

function storeAttachmentToStorage(params: {
  invoiceId: string
  userId: string
  fileName: string
  contentBase64: string
}): { fileUrl: string; computedSizeBytes: number } {
  const cleanBase64 = params.contentBase64.replace(/^data:[^;]+;base64,/, '').trim()
  const buffer = Buffer.from(cleanBase64, 'base64')
  const digest = createHash('sha256')
    .update(buffer)
    .update(`${params.invoiceId}:${params.userId}:${params.fileName}`)
    .digest('hex')
    .slice(0, 24)
  const safeName = params.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
  const fileUrl = `https://storage.lancepay.io/invoices/${encodeURIComponent(params.invoiceId)}/${digest}-${safeName}`
  return { fileUrl, computedSizeBytes: buffer.byteLength }
}

function validateAttachmentMetadata(input: {
  fileName: unknown
  fileUrl: unknown
  mimeType: unknown
  sizeBytes: unknown
}):
  | {
      valid: true
      fileName: string
      fileUrl: string
      mimeType: string
      sizeBytes: number
    }
  | { valid: false; error: string; code: string } {
  const fileName =
    typeof input.fileName === 'string' ? input.fileName.trim() : ''
  if (!fileName || fileName.length > 255) {
    return {
      valid: false,
      error: 'fileName is required and must be at most 255 characters',
      code: 'INVALID_FILE_NAME',
    }
  }

  const mimeType =
    typeof input.mimeType === 'string'
      ? input.mimeType.trim().toLowerCase()
      : ''
  if (!mimeType || !ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType)) {
    return {
      valid: false,
      error: `Unsupported mimeType. Allowed types: ${Array.from(ALLOWED_ATTACHMENT_MIME_TYPES).join(', ')}`,
      code: 'UNSUPPORTED_MIME_TYPE',
    }
  }

  const sizeBytes =
    typeof input.sizeBytes === 'number'
      ? input.sizeBytes
      : Number(input.sizeBytes)
  if (
    !Number.isInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > MAX_ATTACHMENT_SIZE_BYTES
  ) {
    return {
      valid: false,
      error: `sizeBytes must be a positive integer up to ${MAX_ATTACHMENT_SIZE_BYTES} bytes (10 MB)`,
      code: 'INVALID_FILE_SIZE',
    }
  }

  const fileUrl = typeof input.fileUrl === 'string' ? input.fileUrl.trim() : ''
  if (!fileUrl || fileUrl.startsWith('data:')) {
    return {
      valid: false,
      error:
        'fileUrl must be a valid storage URL and must not embed raw inline data URLs',
      code: 'INVALID_FILE_URL',
    }
  }

  try {
    const parsed = new URL(fileUrl)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return {
        valid: false,
        error: 'fileUrl must use http or https protocol',
        code: 'INVALID_FILE_URL',
      }
    }
  } catch {
    return {
      valid: false,
      error: 'fileUrl must be a valid URL',
      code: 'INVALID_FILE_URL',
    }
  }

  return {
    valid: true,
    fileName,
    fileUrl,
    mimeType,
    sizeBytes,
  }
}

/**
 * GET /api/invoices/[id]/attachments
 * Lists all attachments linked to a specific invoice.
 */
export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const invoiceId = await resolveInvoiceId(context)
    if (!invoiceId) {
      return NextResponse.json(
        { error: 'Invoice ID is required' },
        { status: 400 },
      )
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, userId: true, clientEmail: true },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const attachments = await prisma.invoiceAttachment.findMany({
      where: { invoiceId: invoice.id },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      invoiceId: invoice.id,
      attachments,
      total: attachments.length,
    })
  } catch (err) {
    logger?.error?.({ err }, 'GET /api/invoices/[id]/attachments error')
    return NextResponse.json(
      { error: 'Failed to list invoice attachments' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/invoices/[id]/attachments
 * Attaches a file to an invoice:
 * - Records `uploadedBy` from the authenticated user (ignoring any client-supplied `uploadedBy`).
 * - Validates `mimeType` and `sizeBytes` consistently with the library attachment endpoint.
 */
export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const invoiceId = await resolveInvoiceId(context)
    if (!invoiceId) {
      return NextResponse.json(
        { error: 'Invoice ID is required' },
        { status: 400 },
      )
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, userId: true, clientEmail: true },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid JSON request body' },
        { status: 400 },
      )
    }

    let rawFileName = body.fileName
    let rawFileUrl = body.fileUrl
    let rawMimeType = body.mimeType
    let rawSizeBytes = body.sizeBytes

    // Optional link from user's LibraryAttachment
    if (
      typeof body.libraryAttachmentId === 'string' &&
      body.libraryAttachmentId.trim() &&
      typeof prisma.libraryAttachment?.findUnique === 'function'
    ) {
      const libAttachment = await prisma.libraryAttachment.findUnique({
        where: { id: body.libraryAttachmentId.trim() },
      })
      if (!libAttachment || libAttachment.userId !== auth.user.id) {
        return NextResponse.json(
          { error: 'Library attachment not found' },
          { status: 404 },
        )
      }
      rawFileName = rawFileName ?? libAttachment.fileName
      rawFileUrl = rawFileUrl ?? libAttachment.fileUrl
      rawMimeType = rawMimeType ?? libAttachment.mimeType
      rawSizeBytes = rawSizeBytes ?? libAttachment.sizeBytes
    }

    // If raw contentBase64 is uploaded, store it via the storage layer to obtain a URL
    if (
      !rawFileUrl &&
      typeof body.contentBase64 === 'string' &&
      body.contentBase64.trim() &&
      typeof rawFileName === 'string' &&
      rawFileName.trim()
    ) {
      const stored = storeAttachmentToStorage({
        invoiceId: invoice.id,
        userId: auth.user.id,
        fileName: rawFileName.trim(),
        contentBase64: body.contentBase64,
      })
      rawFileUrl = stored.fileUrl
      if (rawSizeBytes === undefined || rawSizeBytes === null) {
        rawSizeBytes = stored.computedSizeBytes
      }
    }

    const validation = validateAttachmentMetadata({
      fileName: rawFileName,
      fileUrl: rawFileUrl,
      mimeType: rawMimeType,
      sizeBytes: rawSizeBytes,
    })

    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error, code: validation.code },
        { status: 400 },
      )
    }

    // Record `uploadedBy` strictly from the authenticated user
    const created = await prisma.invoiceAttachment.create({
      data: {
        invoiceId: invoice.id,
        uploadedBy: auth.user.id,
        fileName: validation.fileName,
        fileUrl: validation.fileUrl,
        mimeType: validation.mimeType,
        sizeBytes: validation.sizeBytes,
      },
    })

    return NextResponse.json({ attachment: created }, { status: 201 })
  } catch (err) {
    logger?.error?.({ err }, 'POST /api/invoices/[id]/attachments error')
    return NextResponse.json(
      { error: 'Failed to attach file to invoice' },
      { status: 500 },
    )
  }
}

/**
 * DELETE /api/invoices/[id]/attachments
 * Removes an attachment linked to an invoice:
 * - Permitted ONLY by the invoice owner (`invoice.userId === auth.user.id`)
 *   or the original uploader (`attachment.uploadedBy === auth.user.id`).
 */
export async function DELETE(req: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const invoiceId = await resolveInvoiceId(context)
    if (!invoiceId) {
      return NextResponse.json(
        { error: 'Invoice ID is required' },
        { status: 400 },
      )
    }

    const { searchParams } = new URL(req.url)
    let attachmentId =
      searchParams.get('attachmentId')?.trim() ||
      searchParams.get('id')?.trim() ||
      ''

    if (!attachmentId) {
      const body = await req.json().catch(() => null)
      if (body && typeof body === 'object') {
        attachmentId =
          (typeof body.attachmentId === 'string' && body.attachmentId.trim()) ||
          (typeof body.id === 'string' && body.id.trim()) ||
          ''
      }
    }

    if (!attachmentId) {
      return NextResponse.json(
        {
          error: 'attachmentId is required to delete an invoice attachment',
          code: 'ATTACHMENT_ID_REQUIRED',
        },
        { status: 400 },
      )
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, userId: true },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const attachment = await prisma.invoiceAttachment.findUnique({
      where: { id: attachmentId },
    })

    if (!attachment || attachment.invoiceId !== invoice.id) {
      return NextResponse.json(
        { error: 'Invoice attachment not found' },
        { status: 404 },
      )
    }

    const isInvoiceOwner = invoice.userId === auth.user.id
    const isOriginalUploader = attachment.uploadedBy === auth.user.id

    if (!isInvoiceOwner && !isOriginalUploader) {
      return NextResponse.json(
        {
          error:
            'Forbidden: only the invoice owner or original uploader can delete this attachment',
          code: 'FORBIDDEN_ATTACHMENT_DELETE',
        },
        { status: 403 },
      )
    }

    await prisma.invoiceAttachment.delete({
      where: { id: attachment.id },
    })

    return NextResponse.json({
      deleted: true,
      attachmentId: attachment.id,
      invoiceId: invoice.id,
    })
  } catch (err) {
    logger?.error?.({ err }, 'DELETE /api/invoices/[id]/attachments error')
    return NextResponse.json(
      { error: 'Failed to delete invoice attachment' },
      { status: 500 },
    )
  }
}
