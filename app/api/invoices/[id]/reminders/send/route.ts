import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { sendInvoiceToClient } from '@/lib/email'
import { logger } from '@/lib/logger'

export const REMINDER_COOLDOWN_MS = 60 * 60 * 1000 // 1 hour
export const NON_REMINDABLE_INVOICE_STATUSES = [
  'paid',
  'void',
  'voided',
  'cancelled',
  'refunded',
] as const

export const ALLOWED_REMINDER_TYPES = [
  'before_due',
  'on_due',
  'after_due',
  'manual',
] as const

const MS_PER_DAY = 24 * 60 * 60 * 1000

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

async function resolveInvoiceId(context?: RouteContext): Promise<string> {
  if (!context?.params) return ''
  const resolved = await Promise.resolve(context.params)
  return (resolved?.id ?? '').trim()
}

export function deriveReminderTypeAndOffset(
  dueDate: Date | string | null | undefined,
  now: Date,
  overrides?: { reminderType?: unknown; daysOffset?: unknown },
): { reminderType: string; daysOffset: number } {
  let computedType = 'manual'
  let computedOffset = 0

  if (dueDate) {
    const due = new Date(dueDate)
    if (!Number.isNaN(due.getTime())) {
      const dueUtcMidnight = Date.UTC(
        due.getUTCFullYear(),
        due.getUTCMonth(),
        due.getUTCDate(),
      )
      const nowUtcMidnight = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
      )
      const deltaDays = Math.round(
        (dueUtcMidnight - nowUtcMidnight) / MS_PER_DAY,
      )
      if (deltaDays > 0) {
        computedType = 'before_due'
        computedOffset = deltaDays
      } else if (deltaDays === 0) {
        computedType = 'on_due'
        computedOffset = 0
      } else {
        computedType = 'after_due'
        computedOffset = Math.abs(deltaDays)
      }
    }
  }

  if (
    overrides?.reminderType &&
    typeof overrides.reminderType === 'string' &&
    (ALLOWED_REMINDER_TYPES as readonly string[]).includes(
      overrides.reminderType.trim(),
    )
  ) {
    computedType = overrides.reminderType.trim()
  }

  if (
    overrides?.daysOffset !== undefined &&
    overrides?.daysOffset !== null &&
    Number.isInteger(Number(overrides.daysOffset)) &&
    Number(overrides.daysOffset) >= 0
  ) {
    computedOffset = Number(overrides.daysOffset)
  }

  return {
    reminderType: computedType,
    daysOffset: computedOffset,
  }
}

async function authenticate(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return {
      error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }),
    }
  }

  const user =
    (await prisma.user.findUnique({ where: { privyId: claims.userId } })) ??
    (await prisma.user.findUnique({ where: { id: claims.userId } }))
  if (!user) {
    return {
      error: NextResponse.json({ error: 'User not found' }, { status: 404 }),
    }
  }

  return { user }
}

/**
 * POST /api/invoices/[id]/reminders/send
 * Manually triggers a `PaymentReminder` for an unpaid invoice:
 * - Rejects sending a reminder for an invoice that is already `paid` or `void`/`cancelled` (`409`).
 * - Records `reminderType` and `daysOffset` consistently with scheduled reminder jobs.
 * - Avoids sending a duplicate reminder within a short cooldown window of the last one (`429`).
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const invoiceId = await resolveInvoiceId(context)
    if (!invoiceId) {
      return NextResponse.json(
        { error: 'Invoice ID is required' },
        { status: 400 },
      )
    }

    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    const invoice =
      typeof prisma.invoice?.findUnique === 'function'
        ? await prisma.invoice.findUnique({ where: { id: invoiceId } })
        : await prisma.invoice.findFirst({ where: { id: invoiceId } })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }
    if (invoice.userId !== user.id && user.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const invoiceStatus = String(invoice.status ?? '').toLowerCase()
    if (
      (NON_REMINDABLE_INVOICE_STATUSES as readonly string[]).includes(
        invoiceStatus,
      )
    ) {
      return NextResponse.json(
        {
          error: `Cannot send a payment reminder for an invoice with status "${invoice.status}"`,
          code: 'INVOICE_NOT_REMINDABLE',
          invoiceStatus: invoice.status,
        },
        { status: 409 },
      )
    }

    const now = new Date()

    // Check cooldown against the most recent reminder for this invoice
    let latestReminder: Record<string, any> | null = null
    if (typeof prisma.paymentReminder?.findFirst === 'function') {
      latestReminder = await prisma.paymentReminder.findFirst({
        where: { invoiceId: invoice.id },
        orderBy: { sentAt: 'desc' },
      })
    } else if (typeof prisma.paymentReminder?.findMany === 'function') {
      const reminders =
        (await prisma.paymentReminder.findMany({
          where: { invoiceId: invoice.id },
          orderBy: { sentAt: 'desc' },
        })) ?? []
      latestReminder = reminders[0] ?? null
    }

    if (latestReminder?.sentAt) {
      const lastSentMs = new Date(latestReminder.sentAt).getTime()
      const elapsedMs = now.getTime() - lastSentMs
      if (!Number.isNaN(lastSentMs) && elapsedMs < REMINDER_COOLDOWN_MS) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((REMINDER_COOLDOWN_MS - elapsedMs) / 1000),
        )
        return NextResponse.json(
          {
            error:
              'A payment reminder was already sent recently for this invoice; please wait before sending another',
            code: 'REMINDER_COOLDOWN_ACTIVE',
            lastSentAt: new Date(lastSentMs).toISOString(),
            retryAfterSeconds,
          },
          {
            status: 429,
            headers: {
              'Retry-After': String(retryAfterSeconds),
            },
          },
        )
      }
    }

    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >

    const { reminderType, daysOffset } = deriveReminderTypeAndOffset(
      invoice.dueDate,
      now,
      {
        reminderType: body?.reminderType,
        daysOffset: body?.daysOffset,
      },
    )

    if (typeof sendInvoiceToClient === 'function') {
      await sendInvoiceToClient({
        clientEmail: invoice.clientEmail,
        clientName: invoice.clientName ?? null,
        freelancerName: user.name || user.email || 'Your freelancer',
        invoiceNumber: invoice.invoiceNumber ?? invoice.id,
        amount: Number(invoice.amount ?? 0),
        currency: invoice.currency ?? 'USD',
        dueDate: invoice.dueDate
          ? new Date(invoice.dueDate).toISOString()
          : null,
        paymentLink: invoice.paymentLink ?? '',
      }).catch((err: unknown) => {
        logger?.warn?.(
          { err, invoiceId: invoice.id },
          'Email delivery skipped/failed during manual reminder',
        )
      })
    }

    const reminder = await prisma.paymentReminder.create({
      data: {
        invoiceId: invoice.id,
        reminderType,
        daysOffset,
        sentAt: now,
      },
    })

    return NextResponse.json(
      {
        reminder: {
          id: reminder.id,
          invoiceId: reminder.invoiceId ?? invoice.id,
          reminderType: reminder.reminderType ?? reminderType,
          daysOffset:
            reminder.daysOffset !== undefined
              ? reminder.daysOffset
              : daysOffset,
          sentAt: new Date(reminder.sentAt ?? now).toISOString(),
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger?.error?.(
      { err: error },
      'POST /api/invoices/[id]/reminders/send error',
    )
    return NextResponse.json(
      { error: 'Failed to send payment reminder' },
      { status: 500 },
    )
  }
}
