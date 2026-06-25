import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export type RoutesDUser = {
  id: string
  role: string
}

export async function getAuthenticatedUser(request: NextRequest): Promise<RoutesDUser | null> {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null

  const claims = await verifyAuthToken(authToken)
  if (!claims) return null

  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, role: true },
  })
}
