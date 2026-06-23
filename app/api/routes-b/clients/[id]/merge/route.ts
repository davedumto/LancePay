import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
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

    const { duplicateClientId } = await request.json()

    if (!duplicateClientId) {
      return NextResponse.json({ error: 'duplicateClientId is required' }, { status: 400 })
    }

    if (id === duplicateClientId) {
      return NextResponse.json({ error: 'Cannot merge a client with itself' }, { status: 400 })
    }

    // Verify both clients belong to the current user
    const primaryClient = await prisma.user.findFirst({
      where: { id, role: 'client' },
    })

    const duplicateClient = await prisma.user.findFirst({
      where: { id: duplicateClientId, role: 'client' },
    })

    if (!primaryClient) {
      return NextResponse.json({ error: 'Primary client not found' }, { status: 404 })
    }

    if (!duplicateClient) {
      return NextResponse.json({ error: 'Duplicate client not found' }, { status: 404 })
    }

    // Check ownership - clients should be associated with the current user's invoices
    const primaryClientInvoices = await prisma.invoice.findMany({
      where: { clientId: id, userId: user.id },
    })

    const duplicateClientInvoices = await prisma.invoice.findMany({
      where: { clientId: duplicateClientId, userId: user.id },
    })

    if (primaryClientInvoices.length === 0 && duplicateClientInvoices.length === 0) {
      return NextResponse.json({ error: 'No ownership over these clients' }, { status: 403 })
    }

    // Merge: update all invoices from duplicate client to primary client
    await prisma.invoice.updateMany({
      where: { clientId: duplicateClientId, userId: user.id },
      data: { clientId: id },
    })

    // Delete the duplicate client
    await prisma.user.delete({
      where: { id: duplicateClientId },
    })

    return NextResponse.json({
      message: 'Clients merged successfully',
      primaryClientId: id,
      duplicateClientId,
      invoicesMerged: duplicateClientInvoices.length,
    })
  } catch (error) {
    logger.error({ err: error }, 'Client merge error')
    return NextResponse.json({ error: 'Failed to merge clients' }, { status: 500 })
  }
}
