import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const { searchParams } = new URL(request.url)
    const entityType = searchParams.get('entityType')

    const where: any = { userId: user.id }
    if (entityType) {
      where.entityType = entityType
    }

    const filters = await prisma.savedFilter.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        entityType: true,
        filters: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ filters })
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const { name, entityType, filters, isDefault = false } = body

    if (!name || !entityType || !filters) {
      return NextResponse.json(
        { error: 'name, entityType, and filters are required' },
        { status: 400 },
      )
    }

    if (typeof filters !== 'object' || filters === null) {
      return NextResponse.json(
        { error: 'filters must be a valid JSON object' },
        { status: 400 },
      )
    }

    // Check if a filter with the same name already exists for this user
    const existing = await prisma.savedFilter.findUnique({
      where: {
        userId_name: {
          userId: user.id,
          name,
        },
      },
    })

    if (existing) {
      return NextResponse.json(
        { error: 'A filter with this name already exists' },
        { status: 409 },
      )
    }

    const filter = await prisma.savedFilter.create({
      data: {
        userId: user.id,
        name,
        entityType,
        filters,
        isDefault,
      },
    })

    return NextResponse.json(filter, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
