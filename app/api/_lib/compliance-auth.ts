import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

export interface ComplianceActor {
  id: string
  role: string
  email: string | null
}

export function isComplianceRole(role: string | null | undefined) {
  const normalized = (role ?? '').toLowerCase()
  return normalized === 'admin' || normalized === 'compliance' || normalized === 'compliance_admin'
}

export async function requireComplianceActor(
  request: NextRequest
): Promise<{ actor: ComplianceActor } | { response: NextResponse }> {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const claims = await verifyAuthToken(authToken)
  if (!claims) return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const actor = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, email: true, role: true },
  })

  if (!actor) return { response: NextResponse.json({ error: 'User not found' }, { status: 404 }) }
  if (!isComplianceRole(actor.role)) {
    return { response: NextResponse.json({ error: 'Forbidden: compliance role required' }, { status: 403 }) }
  }

  return { actor }
}