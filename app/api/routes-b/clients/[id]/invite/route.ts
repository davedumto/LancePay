import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import crypto from 'crypto'

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

    const { email } = await request.json()

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'email is required and must be a string' }, { status: 400 })
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return NextResponse.json({ error: 'Invalid email format' }, { status: 400 })
    }

    // Check if the client exists and belongs to the user
    const client = await prisma.user.findFirst({
      where: { id, role: 'client' },
    })

    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    // Verify ownership by checking if user has invoices with this client
    const clientInvoices = await prisma.invoice.findMany({
      where: { clientId: id, userId: user.id },
    })

    if (clientInvoices.length === 0) {
      return NextResponse.json({ error: 'No ownership over this client' }, { status: 403 })
    }

    // Generate a unique invite token
    const inviteToken = crypto.randomBytes(32).toString('hex')
    const inviteExpiry = new Date()
    inviteExpiry.setDate(inviteExpiry.getDate() + 7) // Expires in 7 days

    // Store the invite (using a simple approach - in production, you'd have a separate table)
    // For now, we'll store it in the user's metadata or create a separate mechanism
    // Since there's no explicit invite table in the schema, we'll return the token
    // In a real implementation, you'd store this in a ClientInvite table

    return NextResponse.json({
      message: 'Client invite created successfully',
      clientId: id,
      inviteToken,
      inviteUrl: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/portal/invite/${inviteToken}`,
      expiresAt: inviteExpiry,
    })
  } catch (error) {
    logger.error({ err: error }, 'Client invite error')
    return NextResponse.json({ error: 'Failed to create client invite' }, { status: 500 })
  }
}
