import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  // 1. Auth
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 2. Fetch Invoice
  const invoice = await prisma.invoice.findUnique({ where: { id } })
  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }
  if (invoice.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // 3. Status Validation
  if (invoice.status !== 'pending') {
    return NextResponse.json(
      { error: 'Due date can only be updated on pending invoices' },
      { status: 422 }
    )
  }

  // 4. dueDate Validation
  let body: { dueDate?: string | null }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!('dueDate' in body)) {
    return NextResponse.json({ error: 'dueDate is required' }, { status: 400 })
  }

  let newDueDate: Date | null = null

  if (body.dueDate !== null) {
    // Must be a string
    if (typeof body.dueDate !== 'string') {
      return NextResponse.json({ error: 'dueDate must be a string or null' }, { status: 400 })
    }

    // Must be a valid ISO date (YYYY-MM-DD or full ISO string)
    const parsed = new Date(body.dueDate)
    if (isNaN(parsed.getTime())) {
      return NextResponse.json({ error: 'Invalid date format' }, { status: 400 })
    }

    // Must be a future date (compare to start of today UTC)
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    if (parsed <= today) {
      return NextResponse.json({ error: 'Due date must be a future date' }, { status: 400 })
    }

    newDueDate = parsed
  }

  // 5. Update
  const updated = await prisma.invoice.update({
    where: { id },
    data: { dueDate: newDueDate },
    select: {
      id: true,
      invoiceNumber: true,
      dueDate: true,
    },
  })

  return NextResponse.json(updated, { status: 200 })
}
