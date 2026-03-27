import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

type ContactDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
}

function getContactDelegate(): ContactDelegate {
  return (prisma as unknown as { contact: ContactDelegate }).contact
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')

  if (!claims) {
    return null
  }

  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const user = await getAuthenticatedUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const contactDelegate = getContactDelegate()
  const contact = await contactDelegate.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      name: true,
      email: true,
      company: true,
      notes: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  if (!contact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
  }

  if (contact.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  return NextResponse.json({
    contact: {
      id: contact.id,
      name: contact.name,
      email: contact.email,
      company: contact.company ?? null,
      notes: contact.notes ?? null,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
    },
  })
}
