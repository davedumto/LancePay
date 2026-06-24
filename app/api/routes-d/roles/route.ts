import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const ROLES = [
  { id: 'freelancer', label: 'Freelancer', description: 'Default role for freelancers using the platform' },
  { id: 'admin', label: 'Admin', description: 'Full administrative access' },
  { id: 'client', label: 'Client', description: 'Client who receives and pays invoices' },
] as const

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })

    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    return NextResponse.json({ roles: ROLES })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/roles error')
    return NextResponse.json({ error: 'Failed to list roles' }, { status: 500 })
  }
}
