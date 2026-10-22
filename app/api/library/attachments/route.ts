import { del, get as getBlob, put } from '@vercel/blob'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const MAX_SIZE_BYTES = 25 * 1024 * 1024
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/csv',
  'text/plain',
])

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const attachmentId = new URL(request.url).searchParams.get('id')
    if (attachmentId) {
      const attachment = await prisma.libraryAttachment.findFirst({
        where: { id: attachmentId, userId: user.id },
        select: { fileName: true, fileUrl: true, mimeType: true },
      })
      if (!attachment) return NextResponse.json({ error: 'Attachment not found' }, { status: 404 })

      const blob = await getBlob(attachment.fileUrl, { access: 'private' })
      if (!blob) return NextResponse.json({ error: 'Attachment not found' }, { status: 404 })
      return new NextResponse(blob.stream, {
        headers: {
          'Content-Type': attachment.mimeType,
          'Content-Disposition': `attachment; filename="${attachment.fileName.replace(/["\\\r\n]/g, '_')}"`,
          'Cache-Control': 'private, no-store',
        },
      })
    }

    const attachments = await prisma.libraryAttachment.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, fileName: true, fileUrl: true, mimeType: true, sizeBytes: true, createdAt: true },
    })
    return NextResponse.json({
      attachments: attachments.map(({ id, ...attachment }) => ({
        ...attachment,
        fileUrl: `/api/library/attachments?id=${encodeURIComponent(id)}`,
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/library/attachments error')
    return NextResponse.json({ error: 'Failed to fetch library attachments' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  let blobUrl: string | undefined
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let formData: FormData
    try {
      formData = await request.formData()
    } catch {
      return NextResponse.json({ error: 'Multipart form data is required' }, { status: 400 })
    }

    const file = formData.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 })
    }
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json({ error: 'File type is not allowed' }, { status: 400 })
    }
    if (file.size <= 0 || file.size > MAX_SIZE_BYTES) {
      return NextResponse.json({ error: `File size must be between 1 and ${MAX_SIZE_BYTES} bytes` }, { status: 400 })
    }

    const fileName = file.name.trim().replace(/[\\/]/g, '_').slice(0, 255)
    if (!fileName) return NextResponse.json({ error: 'fileName is required' }, { status: 400 })

    const blob = await put(`${user.id}/${crypto.randomUUID()}/${fileName}`, file, {
      access: 'private',
      addRandomSuffix: true,
      contentType: file.type,
    })
    blobUrl = blob.url

    const attachment = await prisma.libraryAttachment.create({
      data: { userId: user.id, fileName, fileUrl: blob.url, mimeType: file.type, sizeBytes: file.size },
      select: { id: true, fileName: true, fileUrl: true, mimeType: true, sizeBytes: true, createdAt: true },
    })
    return NextResponse.json({
      attachment: { ...attachment, fileUrl: `/api/library/attachments?id=${encodeURIComponent(attachment.id)}` },
    }, { status: 201 })
  } catch (error) {
    if (blobUrl) await del(blobUrl).catch(() => undefined)
    logger.error({ err: error }, 'POST /api/library/attachments error')
    return NextResponse.json({ error: 'Failed to upload library attachment' }, { status: 500 })
  }
}