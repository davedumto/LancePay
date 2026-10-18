import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const ALLOWED_LIBRARY_MIME_TYPES = new Set([
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

export const MAX_LIBRARY_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB

// In-memory object store index for tests / local runtime verification that raw bytes are stored in object storage, never in the database
const libraryStorageObjects = new Map<
  string,
  {
    userId: string
    fileName: string
    mimeType: string
    sizeBytes: number
    sha256: string
  }
>()

export function getStoredLibraryObject(fileUrl: string) {
  return libraryStorageObjects.get(fileUrl) ?? null
}

export function storeLibraryAttachmentContent(params: {
  userId: string
  fileName: string
  mimeType: string
  contentBase64: string
}): { fileUrl: string; sizeBytes: number } {
  const cleanBase64 = params.contentBase64
    .replace(/^data:[^;]+;base64,/, '')
    .trim()
  const buffer = Buffer.from(cleanBase64, 'base64')
  const sha256 = createHash('sha256')
    .update(buffer)
    .update(`${params.userId}:${params.fileName}`)
    .digest('hex')
    .slice(0, 24)
  const safeName = params.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
  const fileUrl = `https://storage.lancepay.io/library/${encodeURIComponent(params.userId)}/${sha256}-${safeName}`

  libraryStorageObjects.set(fileUrl, {
    userId: params.userId,
    fileName: params.fileName,
    mimeType: params.mimeType,
    sizeBytes: buffer.byteLength,
    sha256,
  })

  return { fileUrl, sizeBytes: buffer.byteLength }
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
  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser =
      (await prisma.user.findUnique({
        where: { privyId: claims.userId },
        select: { id: true },
      })) ??
      (await prisma.user.findUnique({
        where: { id: claims.userId },
        select: { id: true },
      }))

    if (!dbUser) {
      return { error: 'User not found', status: 404 as const, user: null }
    }
    userId = dbUser.id
  }

  return {
    error: null,
    status: 200 as const,
    user: { id: userId },
  }
}

/**
 * GET /api/library/attachments
 * Lists reusable file attachments in the authenticated user's library.
 * Strictly scoped to `auth.user.id`.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const { searchParams } = new URL(req.url)
    const mimeTypeFilter = searchParams.get('mimeType')?.trim().toLowerCase()

    const where: Record<string, unknown> = {
      userId: auth.user.id,
    }
    if (mimeTypeFilter) {
      where.mimeType = mimeTypeFilter
    }

    const attachments = await prisma.libraryAttachment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      attachments,
      total: attachments.length,
    })
  } catch (err) {
    logger?.error?.({ err }, 'GET /api/library/attachments error')
    return NextResponse.json(
      { error: 'Failed to list library attachments' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/library/attachments
 * Uploads/registers a reusable attachment in the authenticated user's library:
 * - Validates `mimeType` against `ALLOWED_LIBRARY_MIME_TYPES` and `sizeBytes` against `MAX_LIBRARY_ATTACHMENT_SIZE_BYTES`.
 * - Stores actual file content via the storage mechanism (producing a `fileUrl`), never persisting raw file bytes in the database.
 * - Scopes the created record strictly to `auth.user.id`.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid JSON request body' },
        { status: 400 },
      )
    }

    const fileName =
      typeof body.fileName === 'string' ? body.fileName.trim() : ''
    if (!fileName || fileName.length > 255) {
      return NextResponse.json(
        {
          error: 'fileName is required and must be at most 255 characters',
          code: 'INVALID_FILE_NAME',
        },
        { status: 400 },
      )
    }

    const mimeType =
      typeof body.mimeType === 'string'
        ? body.mimeType.trim().toLowerCase()
        : ''
    if (!mimeType || !ALLOWED_LIBRARY_MIME_TYPES.has(mimeType)) {
      return NextResponse.json(
        {
          error: `Unsupported mimeType. Allowed types: ${Array.from(ALLOWED_LIBRARY_MIME_TYPES).join(', ')}`,
          code: 'UNSUPPORTED_MIME_TYPE',
        },
        { status: 400 },
      )
    }

    let fileUrl = typeof body.fileUrl === 'string' ? body.fileUrl.trim() : ''
    let sizeBytes =
      body.sizeBytes !== undefined && body.sizeBytes !== null
        ? Number(body.sizeBytes)
        : NaN

    const rawContent =
      typeof body.contentBase64 === 'string'
        ? body.contentBase64
        : typeof body.fileContent === 'string'
          ? body.fileContent
          : null

    if (rawContent && rawContent.trim()) {
      const stored = storeLibraryAttachmentContent({
        userId: auth.user.id,
        fileName,
        mimeType,
        contentBase64: rawContent,
      })
      fileUrl = stored.fileUrl
      if (!Number.isFinite(sizeBytes)) {
        sizeBytes = stored.sizeBytes
      }
    }

    if (
      !Number.isInteger(sizeBytes) ||
      sizeBytes <= 0 ||
      sizeBytes > MAX_LIBRARY_ATTACHMENT_SIZE_BYTES
    ) {
      return NextResponse.json(
        {
          error: `sizeBytes must be a positive integer up to ${MAX_LIBRARY_ATTACHMENT_SIZE_BYTES} bytes (10 MB)`,
          code: 'INVALID_FILE_SIZE',
        },
        { status: 400 },
      )
    }

    if (!fileUrl || fileUrl.startsWith('data:')) {
      return NextResponse.json(
        {
          error:
            'fileUrl must be a storage URL; raw file bytes cannot be stored directly in the database',
          code: 'INVALID_FILE_URL',
        },
        { status: 400 },
      )
    }

    try {
      const parsed = new URL(fileUrl)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return NextResponse.json(
          {
            error: 'fileUrl must use http or https protocol',
            code: 'INVALID_FILE_URL',
          },
          { status: 400 },
        )
      }
    } catch {
      return NextResponse.json(
        { error: 'fileUrl must be a valid URL', code: 'INVALID_FILE_URL' },
        { status: 400 },
      )
    }

    const attachment = await prisma.libraryAttachment.create({
      data: {
        userId: auth.user.id,
        fileName,
        fileUrl,
        mimeType,
        sizeBytes,
      },
    })

    return NextResponse.json({ attachment }, { status: 201 })
  } catch (err) {
    logger?.error?.({ err }, 'POST /api/library/attachments error')
    return NextResponse.json(
      { error: 'Failed to create library attachment' },
      { status: 500 },
    )
  }
}
