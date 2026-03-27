import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    // Verify auth
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
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    return NextResponse.json({
      id: user.id,
      privyId: user.privyId,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
    })
  } catch (error) {
    logger.error({ err: error }, 'Profile GET error')
    return NextResponse.json({ error: 'Failed to get profile' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    // Verify auth
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
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Parse request body
    const body = await request.json()
    const { name } = body

    // Validate name
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }

    if (name.length > 100) {
      return NextResponse.json({ error: 'Name must be 100 characters or less' }, { status: 400 })
    }

    // Update user
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { name: name.trim() },
    })

    return NextResponse.json({
      id: updatedUser.id,
      privyId: updatedUser.privyId,
      email: updatedUser.email,
      name: updatedUser.name,
      createdAt: updatedUser.createdAt,
    })
  } catch (error) {
    logger.error({ err: error }, 'Profile PATCH error')
    return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 })
  }
}