import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'
import { sendInvoiceCreatedEmail } from '@/lib/email'

export type BulkJobStatus = 'processing' | 'completed' | 'failed'

export interface BulkInvoiceItemResult {
  index: number
  success: boolean
  invoice?: { id: string; invoiceNumber: string; paymentLink: string }
  error?: string
  warning?: string
}

export interface BulkInvoicesResponse {
  success: boolean
  jobId: string
  summary: { total: number; successful: number; failed: number }
  results: BulkInvoiceItemResult[]
}

export function parseBooleanLike(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  if (v === 'true' || v === '1' || v === 'yes' || v === 'y' || v === 'on') return true
  if (v === 'false' || v === '0' || v === 'no' || v === 'n' || v === 'off') return false
  return undefined
}

function isValidIsoDateOrDatetime(value: string): boolean {
  // Accept YYYY-MM-DD (date-only) or full ISO datetime strings
  const isoDateOnly = /^\d{4}-\d{2}-\d{2}$/
  if (isoDateOnly.test(value)) return !Number.isNaN(new Date(value).getTime())
  return !Number.isNaN(new Date(value).getTime())
}

export const BulkInvoiceSchema = z.object({
  clientEmail: z.string().email(),
  clientName: z.string().max(255).optional(),
  description: z.string().min(3).max(500),
  amount: z.number().positive(),
  dueDate: z
    .string()
    .optional()
    .refine((v) => v === undefined || isValidIsoDateOrDatetime(v), { message: 'Invalid dueDate format' })
    .refine((v) => {
      if (!v) return true
      const ts = new Date(v).getTime()
      return ts > Date.now()
    }, { message: 'dueDate must be a future date' }),
  sendEmail: z.boolean().optional().default(false),
})

export const BulkInvoicesRequestSchema = z.object({
  invoices: z.array(BulkInvoiceSchema).min(1, 'invoices must not be empty').max(100, 'Max 100 invoices per request'),
  sendEmails: z.boolean().optional().default(false),
})

export type BulkInvoiceInput = z.infer<typeof BulkInvoiceSchema>
export type BulkInvoicesRequest = z.infer<typeof BulkInvoicesRequestSchema>

export type IndexedBulkInvoiceInput = { index: number; invoice: BulkInvoiceInput }

export async function getOrCreateUserFromRequest(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return { error: 'Unauthorized' as const }

  const claims = await verifyAuthToken(authToken)
  if (!claims) return { error: 'Invalid token' as const }

  let user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    const email = (claims as { email?: string }).email || `${claims.userId}@privy.local`
    user = await prisma.user.create({ data: { privyId: claims.userId, email } })
  }

  return { user }
}

export async function enforceBulkRateLimit(userId: string) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const count = await prisma.bulkInvoiceJob.count({
    where: {
      userId,
      createdAt: { gte: oneHourAgo },
    },
  })
  if (count >= 5) return { ok: false as const, error: 'Rate limit exceeded: max 5 bulk requests per hour' }
  return { ok: true as const }
}

async function generateUniqueInvoiceNumber(maxAttempts = 5) {
  for (let i = 0; i < maxAttempts; i++) {
    const invoiceNumber = generateInvoiceNumber()
    const exists = await prisma.invoice.findUnique({ where: { invoiceNumber } })
    if (!exists) return invoiceNumber
  }
  return generateInvoiceNumber()
}

export async function processBulkInvoices(params: {
  request: NextRequest
  userId: string
  items: IndexedBulkInvoiceInput[]
  totalCount: number
  sendEmailsByDefault: boolean
  preResults?: BulkInvoiceItemResult[]
}) {
  const { request, userId, items, totalCount, sendEmailsByDefault } = params
  const preResults = params.preResults ?? []

  const job = await prisma.bulkInvoiceJob.create({
    data: {
      userId,
      totalCount,
      status: 'processing',
      results: JSON.parse(JSON.stringify(preResults)),
    },
    select: { id: true },
  })

  const emailCounts = new Map<string, number>()
  for (const { invoice } of items) {
    const key = invoice.clientEmail.toLowerCase()
    emailCounts.set(key, (emailCounts.get(key) || 0) + 1)
  }

  const results: BulkInvoiceItemResult[] = [...preResults]
  let successCount = 0
  let failedCount = preResults.filter((r) => !r.success).length

  for (const { index, invoice: inv } of items) {
    try {
      const invoiceNumber = await generateUniqueInvoiceNumber()
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin
      const paymentLink = `${baseUrl}/pay/${invoiceNumber}`

      const invoice = await prisma.invoice.create({
        data: {
          userId,
          invoiceNumber,
          clientEmail: inv.clientEmail,
          clientName: inv.clientName,
          description: inv.description,
          amount: inv.amount,
          dueDate: inv.dueDate ? new Date(inv.dueDate) : null,
          paymentLink,
        },
        select: { id: true, invoiceNumber: true, paymentLink: true, clientName: true, clientEmail: true, description: true, amount: true, currency: true, dueDate: true },
      })

      let warning: string | undefined
      const shouldSendEmail = (inv.sendEmail ?? false) || sendEmailsByDefault
      if (shouldSendEmail) {
        const freelancer = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } })
        const emailRes = await sendInvoiceCreatedEmail({
          to: invoice.clientEmail,
          clientName: invoice.clientName || undefined,
          freelancerName: freelancer?.name || 'Freelancer',
          invoiceNumber: invoice.invoiceNumber,
          description: invoice.description,
          amount: Number(invoice.amount),
          currency: invoice.currency,
          paymentLink: invoice.paymentLink,
          dueDate: invoice.dueDate,
        })
        if (!emailRes.success) warning = 'Invoice created but email failed to send'
      }

      const dupCount = emailCounts.get(inv.clientEmail.toLowerCase()) || 0
      if (!warning && dupCount > 1) warning = 'Duplicate clientEmail in batch'

      results.push({
        index,
        success: true,
        invoice: { id: invoice.id, invoiceNumber: invoice.invoiceNumber, paymentLink: invoice.paymentLink },
        warning,
      })
      successCount++
    } catch (e: any) {
      results.push({
        index,
        success: false,
        error: e?.message ? String(e.message) : 'Failed to create invoice',
      })
      failedCount++
    }
  }

  const status: BulkJobStatus = successCount === 0 ? 'failed' : 'completed'
  await prisma.bulkInvoiceJob.update({
    where: { id: job.id },
    data: {
      successCount,
      failedCount,
      status,
      results: JSON.parse(JSON.stringify(results)),
      completedAt: new Date(),
    },
  })

  const response: BulkInvoicesResponse = {
    success: true,
    jobId: job.id,
    summary: {
      total: totalCount,
      successful: successCount,
      failed: failedCount,
    },
    results,
  }

  return response
}

// Minimal CSV parser that supports quoted fields
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      const next = line[i + 1]
      if (inQuotes && next === '"') {
        cur += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

export function parseCsvToInvoices(csvText: string) {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  if (lines.length === 0) return { error: 'CSV is empty' as const }

  const headers = parseCsvLine(lines[0]).map((h) => h.trim())
  const required = ['clientEmail', 'description', 'amount']
  for (const r of required) {
    if (!headers.includes(r)) return { error: `Missing required CSV header: ${r}` as const }
  }

  const rows = lines.slice(1)
  const invoicesRaw: Record<string, string>[] = []

  for (const row of rows) {
    const cols = parseCsvLine(row)
    if (cols.every((c) => c === '')) continue
    const obj: Record<string, string> = {}
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = cols[i] ?? ''
    invoicesRaw.push(obj)
  }

  if (invoicesRaw.length === 0) return { error: 'CSV has no data rows' as const }

  const valid: IndexedBulkInvoiceInput[] = []
  const errors: BulkInvoiceItemResult[] = []

  invoicesRaw.forEach((raw, index) => {
    const amount = Number(raw.amount)
    const sendEmail = parseBooleanLike(raw.sendEmail) ?? undefined

    const candidate = {
      clientEmail: raw.clientEmail,
      clientName: raw.clientName || undefined,
      description: raw.description,
      amount,
      dueDate: raw.dueDate || undefined,
      sendEmail,
    }

    const parsed = BulkInvoiceSchema.safeParse(candidate)
    if (!parsed.success) {
      errors.push({ index, success: false, error: parsed.error.issues[0]?.message || 'Invalid row' })
      return
    }
    valid.push({ index, invoice: parsed.data })
  })

  return { valid, errors, totalCount: invoicesRaw.length }
}

