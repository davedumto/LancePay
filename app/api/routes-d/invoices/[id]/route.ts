import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const claims = await verifyAuthToken(authToken)
  if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  const invoice = await prisma.invoice.findFirst({ where: { id, userId: user?.id } })

  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  return NextResponse.json(invoice)
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const claims = await verifyAuthToken(authToken)
  if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  const invoice = await prisma.invoice.findFirst({ where: { id, userId: user?.id, status: 'pending' } })

  if (!invoice) return NextResponse.json({ error: 'Invoice not found or cannot be deleted' }, { status: 404 })

  await prisma.invoice.update({ where: { id }, data: { status: 'cancelled' } })
  return NextResponse.json({ success: true })
}
