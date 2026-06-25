import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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

  const body = await request.json()
  const { name, email, company, notes } = body ?? {}

  // Validate required fields
  if (
    typeof name !== 'string' ||
    name.trim() === '' ||
    name.trim().length > 100
  ) {
    return NextResponse.json(
      { error: 'name is required and must be at most 100 characters.' },
      { status: 400 },
    )
  }

  if (
    typeof email !== 'string' ||
    email.trim() === '' ||
    !EMAIL_REGEX.test(email.trim())
  ) {
    return NextResponse.json(
      { error: 'A valid email address is required.' },
      { status: 400 },
    )
  }

  // Check duplicate email for this user
  const existing = await prisma.contact.findUnique({
    where: { userId_email: { userId: user.id, email: email.trim() } },
  })
  if (existing) {
    return NextResponse.json(
      { error: 'A contact with this email already exists.' },
      { status: 409 },
    )
  }

  const contact = await prisma.contact.create({
    data: {
      userId: user.id,
      name: name.trim(),
      email: email.trim(),
      company: typeof company === 'string' ? company.trim() || null : null,
      notes: typeof notes === 'string' ? notes.trim() || null : null,
    },
    select: {
      id: true,
      name: true,
      email: true,
      company: true,
    },
  })

  return NextResponse.json(contact, { status: 201 })
}
