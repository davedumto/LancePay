import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

async function GETHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    select: { id: true, userId: true, clientName: true, clientEmail: true },
  })

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  if (invoice.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  return NextResponse.json({
    id: invoice.id,
    clientName: invoice.clientName,
    clientEmail: invoice.clientEmail,
  })
}

async function PATCHHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    select: { id: true, userId: true, status: true },
  })

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  if (invoice.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (invoice.status !== 'pending') {
    return NextResponse.json({ error: 'Only pending invoices can be edited' }, { status: 422 })
  }

  const body = await request.json()
  const updateData: { clientName?: string; clientEmail?: string } = {}

  if (body.clientName !== undefined) {
    if (typeof body.clientName !== 'string' || body.clientName.trim() === '') {
      return NextResponse.json({ error: 'clientName must be a non-empty string' }, { status: 400 })
    }
    if (body.clientName.length > 100) {
      return NextResponse.json({ error: 'clientName must be 100 characters or fewer' }, { status: 400 })
    }
    updateData.clientName = body.clientName.trim()
  }

  if (body.clientEmail !== undefined) {
    if (typeof body.clientEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.clientEmail)) {
      return NextResponse.json({ error: 'clientEmail must be a valid email address' }, { status: 400 })
    }
    updateData.clientEmail = body.clientEmail.trim()
  }

  if (Object.keys(updateData).length === 0) {
    return NextResponse.json({ error: 'No valid fields provided' }, { status: 400 })
  }

  const updated = await prisma.invoice.update({
    where: { id },
    data: updateData,
    select: { id: true, clientName: true, clientEmail: true, updatedAt: true },
  })

  return NextResponse.json(updated)
}

export const GET = withRequestId(GETHandler)
export const PATCH = withRequestId(PATCHHandler)
