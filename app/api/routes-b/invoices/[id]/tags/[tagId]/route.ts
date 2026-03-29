import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; tagId: string }> }
) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { id, tagId } = await params

  const invoice = await prisma.invoice.findUnique({ where: { id } })
  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  if (invoice.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const invoiceTag = await prisma.invoiceTag.findUnique({
    where: {
      invoiceId_tagId: {
        invoiceId: id,
        tagId,
      },
    },
  })

  if (!invoiceTag) return NextResponse.json({ error: 'Tag not found on this invoice' }, { status: 404 })

  await prisma.invoiceTag.delete({
    where: {
      invoiceId_tagId: {
        invoiceId: id,
        tagId,
      },
    },
  })

  return new NextResponse(null, { status: 204 })
}
