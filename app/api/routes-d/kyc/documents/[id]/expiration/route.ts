import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params
    if (!id) {
      return NextResponse.json({ error: 'Document ID is required' }, { status: 400 })
    }

    const document = await prisma.kycDocument.findUnique({
      where: { id },
    })

    if (!document) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    if (document.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const now = new Date()
    let expiresAt: Date | null = null

    // Passports, national IDs, and driver's licenses typically expire in 5 years (calculated from creation).
    // Utility bills and bank statements expire in 90 days.
    // Selfies never expire.
    if (document.documentType === 'utility_bill' || document.documentType === 'bank_statement') {
      expiresAt = new Date(document.createdAt.getTime() + 90 * 24 * 60 * 60 * 1000)
    } else if (['passport', 'national_id', 'drivers_license'].includes(document.documentType)) {
      expiresAt = new Date(document.createdAt.getTime() + 5 * 365 * 24 * 60 * 60 * 1000)
    }

    const isExpired = expiresAt ? now > expiresAt : false
    const daysRemaining = expiresAt 
      ? Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
      : null

    let status = 'valid'
    if (expiresAt) {
      if (isExpired) {
        status = 'expired'
      } else if (daysRemaining !== null && daysRemaining < 30) {
        status = 'expiring_soon'
      }
    }

    return NextResponse.json({
      documentId: document.id,
      documentType: document.documentType,
      status,
      isExpired,
      daysRemaining,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      uploadedAt: document.createdAt.toISOString(),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/kyc/documents/[id]/expiration error')
    return NextResponse.json({ error: 'Failed to fetch document expiration status' }, { status: 500 })
  }
}
