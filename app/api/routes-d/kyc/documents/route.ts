import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── GET /api/routes-d/kyc/documents — list current user's KYC documents ──

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const documents = await prisma.kycDocument.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        documentType: true,
        status: true,
        fileName: true,
        fileUrl: true,
        fileSize: true,
        mimeType: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ documents })
  } catch (error) {
    logger.error({ err: error }, 'KYC documents GET error')
    return NextResponse.json({ error: 'Failed to list KYC documents' }, { status: 500 })
  }
}

// ── POST /api/routes-d/kyc/documents — register a newly uploaded KYC document ──
//
// The actual file upload is expected to land in object storage (S3 / R2)
// before this endpoint is called; the client then POSTs the resulting URL
// + metadata so we can index the document against the user.

const VALID_DOCUMENT_TYPES = [
  'passport',
  'national_id',
  'drivers_license',
  'utility_bill',
  'bank_statement',
  'selfie',
] as const
type DocumentType = typeof VALID_DOCUMENT_TYPES[number]

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024 // 25 MB
const MAX_FILENAME_LENGTH = 200

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const body = (await request.json().catch(() => null)) as
      | { documentType?: string; fileUrl?: string; fileName?: string; fileSize?: number; mimeType?: string }
      | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const { documentType, fileUrl, fileName, fileSize, mimeType } = body
    if (!documentType || !VALID_DOCUMENT_TYPES.includes(documentType as DocumentType)) {
      return NextResponse.json(
        { error: `documentType must be one of: ${VALID_DOCUMENT_TYPES.join(', ')}` },
        { status: 400 },
      )
    }
    if (!fileUrl || typeof fileUrl !== 'string') {
      return NextResponse.json({ error: 'fileUrl is required' }, { status: 400 })
    }
    if (!fileUrl.startsWith('https://')) {
      return NextResponse.json({ error: 'fileUrl must use https://' }, { status: 400 })
    }
    if (fileName !== undefined && (typeof fileName !== 'string' || fileName.length > MAX_FILENAME_LENGTH)) {
      return NextResponse.json({ error: 'fileName must be a string ≤ 200 chars' }, { status: 400 })
    }
    if (fileSize !== undefined) {
      if (typeof fileSize !== 'number' || fileSize <= 0 || fileSize > MAX_FILE_SIZE_BYTES) {
        return NextResponse.json(
          { error: `fileSize must be a positive number ≤ ${MAX_FILE_SIZE_BYTES}` },
          { status: 400 },
        )
      }
    }

    const document = await prisma.kycDocument.create({
      data: {
        userId: user.id,
        documentType: documentType as DocumentType,
        fileUrl,
        fileName: fileName ?? null,
        fileSize: fileSize ?? null,
        mimeType: mimeType ?? null,
      },
    })

    return NextResponse.json({ document }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'KYC documents POST error')
    return NextResponse.json({ error: 'Failed to upload KYC document' }, { status: 500 })
  }
}
