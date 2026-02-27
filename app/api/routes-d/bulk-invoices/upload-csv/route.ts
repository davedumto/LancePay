import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import {
  MAX_BULK_INVOICES,
  enforceBulkRateLimit,
  getOrCreateUserFromRequest,
  parseBooleanLike,
  parseCsvToInvoices,
  processBulkInvoices,
} from '@/app/api/routes-d/bulk-invoices/_shared'

export async function POST(request: NextRequest) {
  try {
    const auth = await getOrCreateUserFromRequest(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })
    const user = auth.user

    const rl = await enforceBulkRateLimit(user.id)
    if (!rl.ok) return NextResponse.json({ error: rl.error }, { status: 429 })

    const form = await request.formData()
    const file = form.get('file')
    const sendEmailsRaw = form.get('sendEmails')

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 })
    }

    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: 'File too large (max 5MB)' }, { status: 400 })
    }

    const filename = file.name || ''
    if (!filename.toLowerCase().endsWith('.csv')) {
      return NextResponse.json({ error: 'Only .csv files are allowed' }, { status: 400 })
    }

    const csvText = await file.text()
    const parsedCsv = parseCsvToInvoices(csvText)
    if ('error' in parsedCsv) return NextResponse.json({ error: parsedCsv.error }, { status: 400 })

    if (parsedCsv.totalCount > MAX_BULK_INVOICES) {
      return NextResponse.json({ error: `Max ${MAX_BULK_INVOICES} invoices per request` }, { status: 429 })
    }

    const sendEmails = parseBooleanLike(sendEmailsRaw) ?? false

    const response = await processBulkInvoices({
      request,
      userId: user.id,
      items: parsedCsv.valid,
      totalCount: parsedCsv.totalCount,
      sendEmailsByDefault: sendEmails,
      preResults: parsedCsv.errors,
    })

    return NextResponse.json(response, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'Bulk invoices upload-csv error:')
    return NextResponse.json({ error: 'Failed to upload CSV' }, { status: 500 })
  }
}

