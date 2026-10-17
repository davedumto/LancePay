import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const ALLOWED_DOCUMENT_TYPES = [
  'passport',
  'national_id',
  'drivers_license',
  'utility_bill',
  'bank_statement',
  'tax_document',
  'selfie',
  'incorporation_certificate',
] as const

const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB

function extractToken(req: NextRequest): string | null {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice(7).trim() || null
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * GET /api/kyc-documents
 * Lists uploaded KYC documents for the authenticated user (or filtered by userId for admins).
 */
export async function GET(req: NextRequest) {
  try {
    const token = extractToken(req)
    const claims = token ? await verifyAuthToken(token) : null
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const requestedUserId = searchParams.get('userId')?.trim()
    const documentType =
      searchParams.get('documentType')?.trim().toLowerCase() || undefined
    const status = searchParams.get('status')?.trim().toLowerCase() || undefined

    if (
      requestedUserId &&
      requestedUserId !== claims.userId &&
      claims.role !== 'admin'
    ) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const targetUserId =
      claims.role === 'admin' && requestedUserId
        ? requestedUserId
        : claims.userId

    const where: Record<string, unknown> = { userId: targetUserId }
    if (documentType) where.documentType = documentType
    if (status) where.status = status

    const documents = await prisma.kycDocument.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      data: documents,
      documents,
      total: documents.length,
    })
  } catch (err) {
    console.error('[GET /api/kyc-documents]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/kyc-documents
 * Submits a KYC document record for verification after validating document type,
 * MIME type, file size limits, and duplicate submission constraints.
 */
export async function POST(req: NextRequest) {
  try {
    const token = extractToken(req)
    const claims = token ? await verifyAuthToken(token) : null
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const documentType =
      typeof body.documentType === 'string'
        ? body.documentType.trim().toLowerCase()
        : ''
    const fileUrl =
      typeof body.fileUrl === 'string' ? body.fileUrl.trim() : ''
    const fileName =
      typeof body.fileName === 'string' ? body.fileName.trim() : ''
    const rawFileSize = body.fileSize
    const mimeType =
      typeof body.mimeType === 'string'
        ? body.mimeType.trim().toLowerCase()
        : ''
    const notes =
      typeof body.notes === 'string' && body.notes.trim()
        ? body.notes.trim()
        : null
    const replace = body.replace === true

    if (
      !documentType ||
      !ALLOWED_DOCUMENT_TYPES.includes(
        documentType as (typeof ALLOWED_DOCUMENT_TYPES)[number],
      )
    ) {
      return NextResponse.json(
        {
          error: `documentType must be one of: ${ALLOWED_DOCUMENT_TYPES.join(', ')}`,
        },
        { status: 400 },
      )
    }

    if (!fileUrl || !isValidHttpUrl(fileUrl)) {
      return NextResponse.json(
        { error: 'fileUrl must be a valid HTTP or HTTPS URL' },
        { status: 400 },
      )
    }

    if (!fileName || fileName.length > 255 || fileName.includes('..')) {
      return NextResponse.json(
        { error: 'Valid fileName is required (max 255 characters)' },
        { status: 400 },
      )
    }

    const fileSize = Number(rawFileSize)
    if (!Number.isInteger(fileSize) || fileSize <= 0) {
      return NextResponse.json(
        { error: 'fileSize must be a positive integer in bytes' },
        { status: 400 },
      )
    }

    if (fileSize > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json(
        {
          error: `fileSize exceeds maximum allowed size of ${MAX_FILE_SIZE_BYTES} bytes (10 MB)`,
        },
        { status: 400 },
      )
    }

    if (
      !mimeType ||
      !ALLOWED_MIME_TYPES.includes(
        mimeType as (typeof ALLOWED_MIME_TYPES)[number],
      )
    ) {
      return NextResponse.json(
        {
          error: `mimeType must be one of: ${ALLOWED_MIME_TYPES.join(', ')}`,
        },
        { status: 400 },
      )
    }

    // Check if KYC application is already approved
    if (typeof prisma.kycApplication?.findUnique === 'function') {
      const existingApp = await prisma.kycApplication.findUnique({
        where: { userId: claims.userId },
      })
      if (existingApp && existingApp.status === 'approved') {
        return NextResponse.json(
          { error: 'KYC application is already approved' },
          { status: 409 },
        )
      }
    }

    // Check for duplicate active/verified document of the same type
    if (!replace && typeof prisma.kycDocument.findFirst === 'function') {
      const existingDoc = await prisma.kycDocument.findFirst({
        where: {
          userId: claims.userId,
          documentType,
          status: { in: ['uploaded', 'under_review', 'verified', 'pending'] },
        },
      })

      if (existingDoc) {
        return NextResponse.json(
          {
            error: `A ${documentType} document is already ${existingDoc.status}`,
            existingDocumentId: existingDoc.id,
          },
          { status: 409 },
        )
      }
    }

    const document = await prisma.kycDocument.create({
      data: {
        userId: claims.userId,
        documentType,
        status: 'uploaded',
        fileUrl,
        fileName,
        fileSize,
        mimeType,
        notes,
      },
    })

    return NextResponse.json(
      {
        document,
        kycDocument: document,
        data: document,
      },
      { status: 201 },
    )
  } catch (err) {
    console.error('[POST /api/kyc-documents]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
