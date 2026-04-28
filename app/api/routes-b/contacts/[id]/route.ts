import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { withBodyLimit } from '../../_lib/with-body-limit'

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  let contactId: string | undefined

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

    const { id } = params
    contactId = id

    const contact = await prisma.contact.findUnique({ where: { id } })

    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    if (contact.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    return NextResponse.json({ contact }, { status: 200 })
  } catch (error) {
    logger.error({ err: error, contactId }, 'Routes B contact GET error')
    return NextResponse.json({ error: 'Failed to fetch contact' }, { status: 500 })
  }
}

async function patchContact(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

    const { id } = await params

    const contact = await prisma.contact.findUnique({ where: { id } })

    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    if (contact.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    let body: { name?: unknown; email?: unknown; company?: unknown; notes?: unknown }

    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const updateData: { name?: string; email?: string; company?: string | null; notes?: string | null } = {}

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 })
      }
      if (body.name.trim().length > 100) {
        return NextResponse.json({ error: 'name must be 100 characters or fewer' }, { status: 400 })
      }
      updateData.name = body.name.trim()
    }

    if (body.email !== undefined) {
      if (typeof body.email !== 'string') {
        return NextResponse.json({ error: 'email must be a valid email address' }, { status: 400 })
      }

      const normalizedEmail = body.email.trim().toLowerCase()
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailPattern.test(normalizedEmail)) {
        return NextResponse.json({ error: 'email must be a valid email address' }, { status: 400 })
      }

      const existingContact = await prisma.contact.findUnique({
        where: { userId_email: { userId: user.id, email: normalizedEmail } },
        select: { id: true },
      })

      if (existingContact && existingContact.id !== id) {
        return NextResponse.json({ error: 'A contact with this email already exists' }, { status: 409 })
      }

      updateData.email = normalizedEmail
    }

    if (body.company !== undefined) {
      if (body.company !== null && typeof body.company !== 'string') {
        return NextResponse.json({ error: 'company must be a string' }, { status: 400 })
      }
      if (typeof body.company === 'string' && body.company.trim().length > 100) {
        return NextResponse.json({ error: 'company must be 100 characters or fewer' }, { status: 400 })
      }
      updateData.company = typeof body.company === 'string' ? body.company.trim() : null
    }

    if (body.notes !== undefined) {
      if (body.notes !== null && typeof body.notes !== 'string') {
        return NextResponse.json({ error: 'notes must be a string' }, { status: 400 })
      }
      if (typeof body.notes === 'string' && body.notes.trim().length > 500) {
        return NextResponse.json({ error: 'notes must be 500 characters or fewer' }, { status: 400 })
      }
      updateData.notes = typeof body.notes === 'string' ? body.notes.trim() : null
    }

    const updatedContact =
      Object.keys(updateData).length === 0
        ? await prisma.contact.findUnique({
            where: { id },
            select: { id: true, name: true, email: true, updatedAt: true },
          })
        : await prisma.contact.update({
            where: { id },
            data: updateData,
            select: { id: true, name: true, email: true, updatedAt: true },
          })

    return NextResponse.json({ contact: updatedContact }, { status: 200 })
  } catch (error) {
    const { id } = await params
    logger.error({ err: error, contactId: id }, 'Routes B contact PATCH error')
    return NextResponse.json({ error: 'Failed to update contact' }, { status: 500 })
  }
}

export const PATCH = withBodyLimit(patchContact)
