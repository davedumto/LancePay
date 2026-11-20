import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
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
      select: { id: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Get all clients owned by this user with their invoice revenue data
    const clients = await prisma.contact.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
      },
    })

    // Calculate revenue per client
    const clientRevenue = await Promise.all(
      clients.map(async (client) => {
        const invoices = await prisma.invoice.findMany({
          where: {
            clientId: client.id,
            userId: user.id,
            status: { not: 'cancelled' },
          },
          select: {
            id: true,
            amount: true,
            status: true,
            dueDate: true,
            createdAt: true,
          },
        })

        const totalAmount = invoices.reduce((sum, invoice) => sum + (invoice.amount ? Number(invoice.amount) : 0), 0)
        const paidAmount = invoices
          .filter((inv) => inv.status === 'paid')
          .reduce((sum, invoice) => sum + (invoice.amount ? Number(invoice.amount) : 0), 0)
        const outstandingAmount = totalAmount - paidAmount

        return {
          clientId: client.id,
          clientName: client.name,
          clientEmail: client.email,
          totalRevenue: totalAmount,
          paidRevenue: paidAmount,
          outstandingRevenue: outstandingAmount,
          invoiceCount: invoices.length,
          createdAt: client.createdAt,
        }
      }),
    )

    // Sort by total revenue descending
    clientRevenue.sort((a, b) => b.totalRevenue - a.totalRevenue)

    return NextResponse.json({ clients: clientRevenue })
  } catch (error) {
    logger.error({ err: error }, 'Get client revenue analytics error')
    return NextResponse.json(
      { error: 'Failed to get client revenue analytics' },
      { status: 500 },
    )
  }
}
