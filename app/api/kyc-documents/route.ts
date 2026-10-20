import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
])
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

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

    const documents = await prisma.kycDocument.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        documentType: true,
        status: true,
        fileUrl: true,
        fileName: true,
        fileSize: true,
        mimeType: true,
        notes: true,
        ocrConfidence: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ documents })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/kyc-documents error')
    return NextResponse.json({ error: 'Failed to fetch KYC documents' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const {
      documentType,
      fileUrl,
      fileName,
      fileSize,
      mimeType,
      notes,
    } = (body ?? {}) as {
      documentType?: string
      fileUrl?: string
      fileName?: string
      fileSize?: number
      mimeType?: string
      notes?: string
    }

    if (!documentType || typeof documentType !== 'string' || !documentType.trim()) {
      return NextResponse.json({ error: 'documentType is required' }, { status: 400 })
    }

    if (!fileUrl || typeof fileUrl !== 'string' || !fileUrl.trim()) {
      return NextResponse.json({ error: 'fileUrl is required' }, { status: 400 })
    }

    if (mimeType && !ALLOWED_MIME_TYPES.has(mimeType)) {
      return NextResponse.json(
        { error: `Invalid mimeType. Allowed types: ${Array.from(ALLOWED_MIME_TYPES).join(', ')}` },
        { status: 400 },
      )
    }

    if (fileSize !== undefined && (typeof fileSize !== 'number' || fileSize <= 0 || fileSize > MAX_FILE_SIZE)) {
      return NextResponse.json(
        { error: `fileSize must be a positive number up to ${MAX_FILE_SIZE} bytes (10MB)` },
        { status: 400 },
      )
    }

    // Ensure KycApplication exists for the user
    await prisma.kycApplication.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        status: 'pending',
        level: 'basic',
      },
    })

    const document = await prisma.kycDocument.create({
      data: {
        userId: user.id,
        documentType: documentType.trim(),
        fileUrl: fileUrl.trim(),
        fileName: fileName?.trim() || null,
        fileSize: fileSize || null,
        mimeType: mimeType?.trim() || null,
        notes: notes?.trim() || null,
        status: 'pending',
      },
    })

    return NextResponse.json({ document }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/kyc-documents error')
    return NextResponse.json({ error: 'Failed to upload KYC document' }, { status: 500 })
  }
}
