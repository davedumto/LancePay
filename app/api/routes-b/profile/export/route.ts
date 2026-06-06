import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { acquireExportLock, releaseExportLock } from '../../_lib/export-limiter'

const encoder = new TextEncoder()
const BATCH = 100

function line(obj: object): Uint8Array {
  return encoder.encode(JSON.stringify(obj) + '\n')
}

async function POSTHandler(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const claims = await verifyAuthToken(authToken)
  if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  if (!acquireExportLock(user.id)) {
    return NextResponse.json({ error: 'Export already in progress for this user' }, { status: 429 })
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // profile section
        controller.enqueue(
          line({
            _section: 'profile',
            id: user.id,
            email: user.email,
            name: user.name ?? null,
            phone: user.phone ?? null,
            createdAt: user.createdAt,
          }),
        )

        // invoices section
        let cursor: string | null = null
        let done = false
        while (!done) {
          const rows = await prisma.invoice.findMany({
            where: { userId: user.id },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            take: BATCH,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            select: {
              id: true,
              invoiceNumber: true,
              clientEmail: true,
              clientName: true,
              amount: true,
              currency: true,
              status: true,
              dueDate: true,
              paidAt: true,
              createdAt: true,
            },
          })
          for (const inv of rows) {
            controller.enqueue(
              line({ _section: 'invoice', ...inv, amount: Number(inv.amount) }),
            )
          }
          if (rows.length < BATCH) done = true
          else cursor = rows[rows.length - 1].id
        }

        // contacts section
        cursor = null
        done = false
        while (!done) {
          const rows = await prisma.contact.findMany({
            where: { userId: user.id },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            take: BATCH,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            select: { id: true, name: true, email: true, company: true, createdAt: true },
          })
          for (const c of rows) controller.enqueue(line({ _section: 'contact', ...c }))
          if (rows.length < BATCH) done = true
          else cursor = rows[rows.length - 1].id
        }

        // withdrawals section
        cursor = null
        done = false
        while (!done) {
          const rows = await prisma.transaction.findMany({
            where: { userId: user.id, type: 'withdrawal' },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            take: BATCH,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            select: {
              id: true,
              type: true,
              status: true,
              amount: true,
              currency: true,
              createdAt: true,
            },
          })
          for (const w of rows) {
            controller.enqueue(line({ _section: 'withdrawal', ...w, amount: Number(w.amount) }))
          }
          if (rows.length < BATCH) done = true
          else cursor = rows[rows.length - 1].id
        }

        // audit-log section
        cursor = null
        done = false
        while (!done) {
          const rows = await prisma.auditEvent.findMany({
            where: { actorId: user.id },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            take: BATCH,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            select: {
              id: true,
              eventType: true,
              invoiceId: true,
              metadata: true,
              createdAt: true,
            },
          })
          for (const e of rows) controller.enqueue(line({ _section: 'audit-log', ...e }))
          if (rows.length < BATCH) done = true
          else cursor = rows[rows.length - 1].id
        }

        controller.close()
      } catch (err) {
        controller.error(err)
      } finally {
        releaseExportLock(user.id)
      }
    },
  })

  return new NextResponse(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Content-Disposition': 'attachment; filename="export.jsonl"',
    },
  })
}

export const POST = withRequestId(POSTHandler)
