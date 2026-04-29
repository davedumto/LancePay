import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateCloudinaryUrl, isExpiredKey } from '../../../_lib/presigned-upload'
import { getMaxFileSize, isAllowedMimeType, sniffMimeType, stripExifMetadata } from '../../../_lib/file-signature'
import { registerRoute } from '../../../_lib/openapi'
import { z } from 'zod'

// Register OpenAPI documentation
registerRoute({
  method: 'POST',
  path: '/profile/avatar/finalize',
  summary: 'Finalize avatar upload',
  description: 'Validate and finalize an avatar upload after direct upload to storage.',
  requestSchema: z.object({
    key: z.string(),
  }),
  responseSchema: z.object({
    avatarUrl: z.string(),
  }),
  tags: ['profile']
})

async function POSTHandler(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const body = await request.json()
    const { key, expiresAt, fileBase64, contentType } = body

    if (!key || typeof key !== 'string') {
      return NextResponse.json({ error: 'key is required' }, { status: 400 })
    }
    if (!fileBase64 || typeof fileBase64 !== 'string') {
      return NextResponse.json({ error: 'fileBase64 is required' }, { status: 400 })
    }

    // Check if the key has expired
    if (expiresAt && isExpiredKey(expiresAt)) {
      return NextResponse.json({ error: 'Upload URL has expired' }, { status: 400 })
    }

    const buffer = Buffer.from(fileBase64, 'base64')
    if (buffer.byteLength > getMaxFileSize()) {
      return NextResponse.json({ error: 'Avatar exceeds 2 MiB limit' }, { status: 413 })
    }

    const sniffedMime = sniffMimeType(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
    if (!sniffedMime || !isAllowedMimeType(sniffedMime)) {
      return NextResponse.json({ error: 'Unsupported avatar MIME type' }, { status: 415 })
    }

    if (contentType && contentType !== sniffedMime) {
      return NextResponse.json({ error: 'MIME type mismatch' }, { status: 415 })
    }

    // Strip EXIF metadata from JPEG uploads before persisting avatar reference.
    stripExifMetadata(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), sniffedMime)

    const avatarUrl = generateCloudinaryUrl(key)

    // Update user's avatar URL
    await prisma.user.update({
      where: { id: user.id },
      data: { avatarUrl },
    })

    return NextResponse.json({ avatarUrl })
  } catch (error) {
    console.error('Avatar finalize error:', error)
    return NextResponse.json({ error: 'Failed to finalize avatar upload' }, { status: 500 })
  }
}

export const POST = withRequestId(POSTHandler)
