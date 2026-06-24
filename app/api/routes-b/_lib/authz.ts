import { NextRequest } from 'next/server'
import crypto from 'crypto'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export class RoutesBForbiddenError extends Error {
  code = 'FORBIDDEN'
  status = 403
}

type AuthContext = { userId: string; role: string; scopes: string[] }

export async function resolveRoutesBAuth(req: NextRequest): Promise<AuthContext | null> {
  const authHeader = req.headers.get('authorization')
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!token) return null

  const claims = await verifyAuthToken(token)
  if (claims?.userId) {
    const user = await prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true, role: true } })
    if (!user) return null
    return { userId: user.id, role: user.role, scopes: ['routes-b:read'] }
  }

  const hashedKey = crypto.createHash('sha256').update(token).digest('hex')
  const apiKey = await prisma.apiKey.findUnique({ where: { hashedKey }, select: { id: true, userId: true, isActive: true, name: true } })
  if (!apiKey || !apiKey.isActive || !apiKey.name.startsWith('routes-b-pat:')) return null

  const user = await prisma.user.findUnique({ where: { id: apiKey.userId }, select: { role: true } })
  if (!user) return null

  await prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
  return { userId: apiKey.userId, role: user.role, scopes: ['routes-b:read'] }
}

export async function requireScope(req: NextRequest, scope: string): Promise<AuthContext> {
  const auth = await resolveRoutesBAuth(req)
  if (!auth || !auth.scopes.includes(scope)) throw new RoutesBForbiddenError('Missing required scope')
  return auth
}

export async function requireRole(req: NextRequest, role: string): Promise<AuthContext> {
  const auth = await resolveRoutesBAuth(req)
  if (!auth || auth.role !== role) throw new RoutesBForbiddenError('Missing required role')
  return auth
}

export function hasScope(scopes: string[], scope: string): boolean {
  return scopes.includes(scope)
}
