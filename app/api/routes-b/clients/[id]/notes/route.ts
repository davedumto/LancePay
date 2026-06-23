import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: clientId } = await params

    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Verify the client exists
    const client = await prisma.user.findUnique({ where: { id: clientId } })
    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    const notes = await prisma.clientNote.findMany({
      where: { userId: user.id, clientId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        clientId: true,
        content: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ notes })
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: clientId } = await params

    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Verify the client exists
    const client = await prisma.user.findUnique({ where: { id: clientId } })
    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const { content } = body

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return NextResponse.json(
        { error: 'content is required and must be a non-empty string' },
        { status: 400 },
      )
    }

    const note = await prisma.clientNote.create({
      data: {
        userId: user.id,
        clientId,
        content: content.trim(),
      },
    })

    return NextResponse.json(note, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
