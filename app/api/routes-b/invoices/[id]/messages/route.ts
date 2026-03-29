import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null

  const claims = await verifyAuthToken(authToken)
  if (!claims) return null

  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, name: true, email: true },
  })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const user = await getAuthenticatedUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    select: { id: true, userId: true },
  })

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  if (invoice.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: { content?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { content } = body

  if (!content || typeof content !== 'string' || content.trim() === '') {
    return NextResponse.json({ error: 'content is required and must be a non-empty string' }, { status: 400 })
  }

  if (content.length > 1000) {
    return NextResponse.json({ error: 'content must be 1000 characters or fewer' }, { status: 400 })
  }

  const message = await prisma.invoiceMessage.create({
    data: {
      invoiceId: invoice.id,
      senderType: 'freelancer',
      senderName: user.name ?? user.email,
      content: content.trim(),
    },
    select: {
      id: true,
      invoiceId: true,
      senderType: true,
      senderName: true,
      content: true,
      createdAt: true,
    },
  })

  return NextResponse.json(message, { status: 201 })
}
