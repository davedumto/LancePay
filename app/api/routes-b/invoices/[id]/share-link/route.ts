/**
 * POST /api/routes-b/invoices/[id]/share-link
 * Mint a read-only share token for an invoice.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { mintShareToken } from '../../../_lib/share-tokens'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const invoice = await prisma.invoice.findFirst({
    where: { id, userId: user.id },
    select: { id: true },
  })

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  const entry = mintShareToken(invoice.id, user.id)
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${request.headers.get('host')}`

  return NextResponse.json(
    {
      url: `${baseUrl}/api/routes-b/invoices/public/${entry.token}`,
      token: entry.token,
      expiresAt: entry.expiresAt.toISOString(),
    },
    { status: 201 },
  )
}
