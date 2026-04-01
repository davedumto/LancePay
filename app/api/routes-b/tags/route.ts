import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const tags = await prisma.tag.findMany({
    where: { userId: user.id },
    orderBy: { name: 'asc' },
    include: { _count: { select: { invoiceTags: true } } },
  })

  return NextResponse.json({
    tags: tags.map((tag: any) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      invoiceCount: tag._count.invoiceTags,
      createdAt: tag.createdAt,
    })),
  })
}

export async function POST(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  try {
    const body = await request.json()
    const { name, color = '#6366f1' } = body

    // Validation
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Tag name is required' }, { status: 400 })
    }
    if (name.length > 50) {
      return NextResponse.json({ error: 'Tag name must be at most 50 characters' }, { status: 400 })
    }
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
      return NextResponse.json({ error: 'Invalid hex color format' }, { status: 400 })
    }

    // Duplicate check
    const existingTag = await prisma.tag.findUnique({
      where: { userId_name: { userId: user.id, name } },
    })
    if (existingTag) {
      return NextResponse.json({ error: 'Tag with this name already exists' }, { status: 409 })
    }

    const tag = await prisma.tag.create({
      data: {
        userId: user.id,
        name,
        color,
      },
    })

    return NextResponse.json(
      {
        id: tag.id,
        name: tag.name,
        color: tag.color,
        invoiceCount: 0,
      },
      { status: 201 }
    )
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
