import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Verify auth
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
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Parse request body
    const body = await request.json()
    const { content } = body

    // Validate content
    if (!content || typeof content !== 'string' || content.trim() === '') {
      return NextResponse.json({ error: 'Content is required' }, { status: 400 })
    }

    if (content.length > 1000) {
      return NextResponse.json({ error: 'Content must be 1000 characters or less' }, { status: 400 })
    }

    // Find invoice
    const invoice = await prisma.invoice.findUnique({
      where: { id: params.id },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    // Verify ownership
    if (invoice.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Create message
    const message = await prisma.invoiceMessage.create({
      data: {
        invoiceId: invoice.id,
        senderType: 'freelancer',
        senderName: user.name || user.email,
        content: content.trim(),
      },
    })

    return NextResponse.json(
      {
        id: message.id,
        invoiceId: message.invoiceId,
        senderType: message.senderType,
        senderName: message.senderName,
        content: message.content,
        createdAt: message.createdAt,
      },
      { status: 201 }
    )
  } catch (error) {
    logger.error({ err: error }, 'Invoice message POST error')
    return NextResponse.json({ error: 'Failed to create message' }, { status: 500 })
  }
}