import { withRequestId } from '../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { prisma } from '@/lib/db'
import { requireScope, RoutesBForbiddenError } from '../_lib/authz'

const CAP = 10

function mask(token: string) { return `${token.slice(0, 6)}...${token.slice(-4)}` }

async function POSTHandler(request: NextRequest) {
  try {
    const auth = await requireScope(request, 'routes-b:read')
    const count = await prisma.apiKey.count({ where: { userId: auth.userId, name: { startsWith: 'routes-b-pat:' }, isActive: true } })
    if (count >= CAP) return NextResponse.json({ error: 'Token cap exceeded' }, { status: 400 })

    const token = `lpb_${crypto.randomBytes(24).toString('hex')}`
    const hashedKey = crypto.createHash('sha256').update(token).digest('hex')
    const hint = `${token.slice(0, 6)}...${token.slice(-4)}`

    const row = await prisma.apiKey.create({ data: { userId: auth.userId, name: `routes-b-pat:${Date.now()}`, keyHint: hint, hashedKey, isActive: true } })
    return NextResponse.json({ id: row.id, token, masked: mask(token), scopes: ['routes-b:read'] }, { status: 201 })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) return NextResponse.json({ error: 'Forbidden', code: error.code }, { status: 403 })
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

async function GETHandler(request: NextRequest) {
  try {
    const auth = await requireScope(request, 'routes-b:read')
    const tokens = await prisma.apiKey.findMany({ where: { userId: auth.userId, name: { startsWith: 'routes-b-pat:' } }, orderBy: { createdAt: 'desc' } })
    return NextResponse.json({ tokens: tokens.map((t) => ({ id: t.id, token: t.keyHint, lastUsedAt: t.lastUsedAt, scopes: ['routes-b:read'], revoked: !t.isActive })) })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) return NextResponse.json({ error: 'Forbidden', code: error.code }, { status: 403 })
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

export const GET = withRequestId(GETHandler)
export const POST = withRequestId(POSTHandler)
