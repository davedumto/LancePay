import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireScope, RoutesBForbiddenError } from '../../_lib/authz'

async function DELETEHandler(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const auth = await requireScope(request, 'routes-b:read')
    const token = await prisma.apiKey.findFirst({ where: { id: params.id, userId: auth.userId, name: { startsWith: 'routes-b-pat:' } } })
    if (!token) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    await prisma.apiKey.update({ where: { id: token.id }, data: { isActive: false } })
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) return NextResponse.json({ error: 'Forbidden', code: error.code }, { status: 403 })
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

export const DELETE = withRequestId(DELETEHandler)
