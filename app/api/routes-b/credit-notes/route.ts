import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { createCreditNote, getAllCreditNotes } from '../_lib/credit-notes'
import { registerRoute } from '../_lib/openapi'
import { z } from 'zod'

// Register OpenAPI documentation
registerRoute({
  method: 'GET',
  path: '/credit-notes',
  summary: 'List credit notes',
  description: 'Get all credit notes for the authenticated user.',
  responseSchema: z.array(z.object({
    id: z.string(),
    invoiceId: z.string(),
    amount: z.number(),
    currency: z.string(),
    reason: z.string(),
    number: z.string(),
    issuedAt: z.string()
  })),
  tags: ['credit-notes']
})

registerRoute({
  method: 'POST',
  path: '/credit-notes',
  summary: 'Create credit note',
  description: 'Create a new credit note manually.',
  requestSchema: z.object({
    invoiceId: z.string(),
    amount: z.number().positive(),
    currency: z.string(),
    reason: z.string()
  }),
  responseSchema: z.object({
    id: z.string(),
    number: z.string()
  }),
  tags: ['credit-notes']
})

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const notes = await getAllCreditNotes(user.id)
    return NextResponse.json(notes)
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch credit notes' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const body = await request.json()
    const { invoiceId, amount, currency, reason } = body

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId, userId: user.id }
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const note = await createCreditNote(user.id, {
      invoiceId,
      amount,
      currency,
      reason
    })

    return NextResponse.json(note, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: 'Failed to create credit note' }, { status: 500 })
  }
}
