import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from '@/app/api/cron/cancel-overdue-invoices/route'
import { prisma } from '@/lib/db'
import { sendInvoiceCancelledEmail } from '@/lib/email'
import { logAuditEvent } from '@/lib/audit'

const mockTx = {
    invoice: {
        update: vi.fn(),
    },
}

vi.mock('@/lib/db', () => ({
    prisma: {
        invoice: {
            findMany: vi.fn(),
            update: vi.fn(),
        },
        $transaction: vi.fn(async (callback: any) => {
            return callback(mockTx)
        }),
    },
}))

vi.mock('@/lib/email', () => ({
    sendInvoiceCancelledEmail: vi.fn().mockResolvedValue({ success: true }),
}))

vi.mock('@/lib/audit', () => ({
    logAuditEvent: vi.fn().mockResolvedValue(true),
}))

describe('Cancel Overdue Invoices Cron', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        process.env.CRON_SECRET = 'test-secret'
        vi.mocked(mockTx.invoice.update).mockReset()
        vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
            return callback(mockTx)
        })
    })

    const makeAuthRequest = (token = 'Bearer test-secret') => {
        return new Request('http://localhost:3000/api/cron/cancel-overdue-invoices', {
            headers: { authorization: token },
        })
    }

    it('rejects an unauthorized request', async () => {
        const res = await GET(makeAuthRequest('Bearer wrong-secret'))
        expect(res.status).toBe(401)
    })

    it('fetches eligible invoices with correct where clause including all exclusions', async () => {
        vi.mocked(prisma.invoice.findMany).mockResolvedValueOnce([])
        await GET(makeAuthRequest())

        expect(prisma.invoice.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    status: 'pending',
                    doNotAutoCancel: false,
                    dispute: { is: null },
                    escrowEnabled: false,
                }),
            })
        )

        const calls = vi.mocked(prisma.invoice.findMany).mock.calls
        const where = calls[0][0].where as any
        expect(where.dueDate.lt).toBeInstanceOf(Date)

        const msDiff = Date.now() - where.dueDate.lt.getTime()
        const daysDiff = msDiff / (1000 * 60 * 60 * 24)
        expect(daysDiff).toBeCloseTo(90, 0)
    })

    it('processes an eligible invoice in a transaction: updates status and writes audit log with tx', async () => {
        const mockInvoice = {
            id: 'inv-123',
            invoiceNumber: 'INV001',
            amount: '500.00',
            clientEmail: 'client@example.com',
            dueDate: new Date(Date.now() - 95 * 24 * 60 * 60 * 1000), // 95 days ago
            user: { name: 'Freelancer', email: 'free@lancer.com' },
        }

        vi.mocked(prisma.invoice.findMany).mockResolvedValueOnce([mockInvoice as any])
        vi.mocked(mockTx.invoice.update).mockResolvedValueOnce({ ...mockInvoice, status: 'cancelled' } as any)

        const res = await GET(makeAuthRequest())
        const json = await res.json()

        expect(json.success).toBe(true)
        expect(json.cancelledCount).toBe(1)
        expect(json.cancelledInvoiceIds).toContain('inv-123')

        // Verified executed inside transaction
        expect(prisma.$transaction).toHaveBeenCalledTimes(1)
        expect(mockTx.invoice.update).toHaveBeenCalledWith({
            where: { id: 'inv-123' },
            data: expect.objectContaining({
                status: 'cancelled',
                cancellationReason: 'Auto-cancelled: 90 days overdue',
                lienActive: false,
            }),
        })

        // Audit event called WITH tx client
        expect(logAuditEvent).toHaveBeenCalledWith(
            'inv-123',
            'invoice.auto_cancelled',
            null,
            { reason: 'Auto-cancelled: 90 days overdue' },
            mockTx
        )

        // Email sent fire-and-forget after commit
        expect(sendInvoiceCancelledEmail).toHaveBeenCalledWith(
            expect.objectContaining({
                to: 'free@lancer.com',
                invoiceNumber: 'INV001',
                amount: 500,
                daysOverdue: expect.any(Number),
            })
        )
    })

    it('rolls back transaction if audit log event fails, keeping invoice pending and uncounted', async () => {
        const mockInvoice = {
            id: 'inv-fail-audit',
            invoiceNumber: 'INV002',
            amount: '750.00',
            clientEmail: 'client@example.com',
            dueDate: new Date(Date.now() - 95 * 24 * 60 * 60 * 1000),
            user: { name: 'Freelancer', email: 'free@lancer.com' },
        }

        vi.mocked(prisma.invoice.findMany).mockResolvedValueOnce([mockInvoice as any])
        vi.mocked(mockTx.invoice.update).mockResolvedValueOnce({ ...mockInvoice, status: 'cancelled' } as any)
        vi.mocked(logAuditEvent).mockRejectedValueOnce(new Error('Audit DB constraint violation'))

        const res = await GET(makeAuthRequest())
        const json = await res.json()

        expect(json.success).toBe(true)
        expect(json.cancelledCount).toBe(0)
        expect(json.cancelledInvoiceIds).toEqual([])

        // Email should NOT be sent if transaction failed
        expect(sendInvoiceCancelledEmail).not.toHaveBeenCalled()
    })

    it('continues successfully if email sending fails after transaction commits', async () => {
        const mockInvoice = {
            id: 'inv-email-fail',
            invoiceNumber: 'INV003',
            amount: '300.00',
            clientEmail: 'client@example.com',
            dueDate: new Date(Date.now() - 95 * 24 * 60 * 60 * 1000),
            user: { name: 'Freelancer', email: 'free@lancer.com' },
        }

        vi.mocked(prisma.invoice.findMany).mockResolvedValueOnce([mockInvoice as any])
        vi.mocked(mockTx.invoice.update).mockResolvedValueOnce({ ...mockInvoice, status: 'cancelled' } as any)
        vi.mocked(sendInvoiceCancelledEmail).mockRejectedValueOnce(new Error('Email service unavailable'))

        const res = await GET(makeAuthRequest())
        const json = await res.json()

        expect(json.success).toBe(true)
        expect(json.cancelledCount).toBe(1)
        expect(json.cancelledInvoiceIds).toContain('inv-email-fail')
    })
})
