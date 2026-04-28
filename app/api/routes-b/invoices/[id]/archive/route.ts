import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const invoice = await prisma.invoice.findUnique({ where: { id }, select: { id: true, userId: true, isConfidential: true } })
  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  if (invoice.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const updated = await prisma.invoice.update({
    where: { id },
    data: { isConfidential: true },
    select: { id: true, status: true, isConfidential: true },
  })

  return NextResponse.json({ invoice: { id: updated.id, status: updated.status, archived: updated.isConfidential } })
}
