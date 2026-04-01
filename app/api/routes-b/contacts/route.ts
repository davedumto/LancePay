import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search')

    const contacts = await prisma.contact.findMany({
      where: {
        userId: user.id,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' as const } },
                { email: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        email: true,
        company: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ contacts })
  } catch (error) {
    logger.error({ err: error }, 'Routes B contacts GET error')
    return NextResponse.json({ error: 'Failed to get contacts' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const body = await request.json()
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const company = typeof body?.company === 'string' ? body.company.trim() : null
    const notes = typeof body?.notes === 'string' ? body.notes.trim() : null

    if (!name || name.length === 0) {
      return NextResponse.json({ error: 'Missing name' }, { status: 400 })
    }
    if (name.length > 100) {
      return NextResponse.json({ error: 'Name too long' }, { status: 400 })
    }

    if (!email || email.length === 0) {
      return NextResponse.json({ error: 'Missing email' }, { status: 400 })
    }

    // simple email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return NextResponse.json({ error: 'Invalid email' }, { status: 400 })
    }

    // check for existing contact for this user with same email
    const existing = await prisma.contact.findFirst({ where: { userId: user.id, email } })
    if (existing) {
      return NextResponse.json({ error: 'Contact with this email already exists' }, { status: 409 })
    }

    const contact = await prisma.contact.create({
      data: {
        userId: user.id,
        name,
        email,
        company,
        notes,
      },
      select: {
        id: true,
        name: true,
        email: true,
        company: true,
      },
    })

    return NextResponse.json(contact, { status: 201 })
  } catch (error: any) {
    // handle unique constraint from Prisma just in case
    if (error?.code === 'P2002') {
      return NextResponse.json({ error: 'Contact with this email already exists' }, { status: 409 })
    }
    logger.error({ err: error }, 'Routes B contacts POST error')
    return NextResponse.json({ error: 'Failed to create contact' }, { status: 500 })
  }
}
