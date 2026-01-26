import { NextRequest, NextResponse } from 'next/server'
import {
  BulkInvoiceSchema,
  enforceBulkRateLimit,
  getOrCreateUserFromRequest,
  processBulkInvoices,
} from '@/app/api/routes-d/bulk-invoices/_shared'
import { z } from 'zod'

export async function POST(request: NextRequest) {
  try {
    const auth = await getOrCreateUserFromRequest(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })
    const user = auth.user

    const rl = await enforceBulkRateLimit(user.id)
    if (!rl.ok) return NextResponse.json({ error: rl.error }, { status: 429 })

    const body = await request.json()
    const shape = z.object({
      invoices: z.array(z.unknown()).min(1, 'invoices must not be empty').max(100, 'Max 100 invoices per request'),
      sendEmails: z.boolean().optional().default(false),
    })
    const parsedBody = shape.safeParse(body)
    if (!parsedBody.success) {
      return NextResponse.json({ error: parsedBody.error.issues[0]?.message || 'Invalid request' }, { status: 400 })
    }

    const { invoices, sendEmails } = parsedBody.data

    const items: { index: number; invoice: any }[] = []
    const preResults: { index: number; success: boolean; error?: string }[] = []

    invoices.forEach((candidate, index) => {
      const parsed = BulkInvoiceSchema.safeParse(candidate)
      if (!parsed.success) {
        preResults.push({ index, success: false, error: parsed.error.issues[0]?.message || 'Invalid invoice' })
        return
      }
      items.push({ index, invoice: parsed.data })
    })

    const response = await processBulkInvoices({
      request,
      userId: user.id,
      items,
      totalCount: invoices.length,
      sendEmailsByDefault: sendEmails ?? false,
      preResults,
    })

    return NextResponse.json(response, { status: 200 })
  } catch (error) {
    console.error('Bulk invoices create error:', error)
    return NextResponse.json({ error: 'Failed to create bulk invoices' }, { status: 500 })
  }
}

