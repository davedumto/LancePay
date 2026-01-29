import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getReceiptAbsolutePath } from '@/lib/file-storage'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ paymentId: string }> }
) {
  try {
    const { paymentId } = await params

    // Auth check
    const authToken = request.headers
      .get('authorization')
      ?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Fetch payment
    const payment = await prisma.manualPayment.findUnique({
      where: { id: paymentId },
      include: {
        invoice: { select: { userId: true } },
      },
    })

    if (!payment) {
      return NextResponse.json(
        { error: 'Payment not found' },
        { status: 404 }
      )
    }

    // Ownership check
    if (payment.invoice.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Get file path
    const absolutePath = getReceiptAbsolutePath(payment.receiptUrl)
    if (!absolutePath) {
      return NextResponse.json(
        { error: 'Invalid receipt path' },
        { status: 400 }
      )
    }

    // Check file exists
    if (!existsSync(absolutePath)) {
      return NextResponse.json(
        { error: 'Receipt file not found' },
        { status: 404 }
      )
    }

    // Read file
    const fileBuffer = await readFile(absolutePath)

    // Determine content type
    const ext = path.extname(absolutePath).toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'

    // Return file
    return new NextResponse(fileBuffer, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="${path.basename(absolutePath)}"`,
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (error) {
    console.error('Receipt download error:', error)
    return NextResponse.json(
      { error: 'Failed to retrieve receipt' },
      { status: 500 }
    )
  }
}
