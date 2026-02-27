import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST as releaseRoute } from '@/app/api/routes-d/escrow/release/route';
import { prisma } from '@/lib/db';
import * as shared from '@/app/api/routes-d/escrow/_shared';
import * as waterfallLib from '@/lib/waterfall';
import * as stellarLib from '@/lib/stellar';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
    prisma: {
        invoice: {
            findUnique: vi.fn(),
            updateMany: vi.fn(),
        },
        escrowEvent: {
            create: vi.fn(),
        },
        $transaction: vi.fn((cb) => cb(prisma)),
    },
}));

vi.mock('@/app/api/routes-d/escrow/_shared', () => ({
    EscrowReleaseSchema: {
        safeParse: vi.fn(),
    },
    getAuthContext: vi.fn(),
    releaseEscrowFunds: vi.fn(),
}));

vi.mock('@/lib/waterfall', () => ({
    processWaterfallPayments: vi.fn(),
}));

vi.mock('@/lib/stellar', () => ({
    sendStellarPayment: vi.fn(),
}));

vi.mock('@/lib/email', () => ({
    sendEscrowReleasedEmail: vi.fn(),
}));

describe('Escrow Release with Collaborators', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.STELLAR_FUNDING_WALLET_SECRET = 'SBFES63435GQ64ZKPIGI332O2KIZ2YMXGTG4VRRC6GNXE2WUCMF3GXU7';
    });

    const mockRequest = (body: any) => {
        return {
            json: vi.fn().mockResolvedValue(body),
            headers: new Headers({ authorization: 'Bearer token' }),
        } as unknown as NextRequest;
    };

    it('should distribute funds via waterfall when collaborators exist', async () => {
        // Setup
        const invoiceId = 'inv_123';
        const freelancerWallet = 'G_FREELANCER';
        const collaboratorWallet = 'G_COLLABORATOR';

        vi.mocked(shared.getAuthContext).mockResolvedValue({ email: 'client@example.com', user: {} } as any);
        vi.mocked(shared.EscrowReleaseSchema.safeParse).mockReturnValue({
            success: true,
            data: { invoiceId, clientEmail: 'client@example.com' }
        } as any);

        const mockInvoice = {
            id: invoiceId,
            amount: 1000,
            clientEmail: 'client@example.com',
            escrowEnabled: true,
            escrowStatus: 'held',
            invoiceNumber: 'INV-001',
            user: { wallet: { address: freelancerWallet }, email: 'free@example.com' },
            collaborators: [{ id: 'col_1' }],
        };

        vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice as any);
        vi.mocked(prisma.invoice.updateMany).mockResolvedValue({ count: 1 } as any);

        vi.mocked(waterfallLib.processWaterfallPayments).mockResolvedValue({
            processed: true,
            leadShare: 700,
            distributions: [
                {
                    subContractorId: 'sub_1',
                    email: 'sub@example.com',
                    walletAddress: collaboratorWallet,
                    sharePercentage: 30,
                    amount: 300,
                    status: 'completed',
                }
            ]
        } as any);

        // Execute
        const res = await releaseRoute(mockRequest({ invoiceId, clientEmail: 'client@example.com' }));
        const data = await res.json();

        // Verify
        expect(res.status).toBe(200);
        expect(stellarLib.sendStellarPayment).toHaveBeenCalledTimes(2);
        // Freelancer gets 700 (70%)
        expect(stellarLib.sendStellarPayment).toHaveBeenCalledWith(
            expect.any(String), expect.any(String), freelancerWallet, "700", expect.any(String)
        );
        // Collaborator gets 300 (30%)
        expect(stellarLib.sendStellarPayment).toHaveBeenCalledWith(
            expect.any(String), expect.any(String), collaboratorWallet, "300", expect.any(String)
        );
    });

    it('should send full amount when no collaborators', async () => {
        const invoiceId = 'inv_456';
        const freelancerWallet = 'G_FREELANCER';

        vi.mocked(shared.getAuthContext).mockResolvedValue({ email: 'client@example.com', user: {} } as any);
        vi.mocked(shared.EscrowReleaseSchema.safeParse).mockReturnValue({
            success: true,
            data: { invoiceId, clientEmail: 'client@example.com' }
        } as any);

        const mockInvoice = {
            id: invoiceId,
            amount: 1000,
            clientEmail: 'client@example.com',
            escrowEnabled: true,
            escrowStatus: 'held',
            invoiceNumber: 'INV-002',
            user: { wallet: { address: freelancerWallet }, email: 'free@example.com' },
            collaborators: [],
        };

        vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice as any);
        vi.mocked(prisma.invoice.updateMany).mockResolvedValue({ count: 1 } as any);

        const res = await releaseRoute(mockRequest({ invoiceId, clientEmail: 'client@example.com' }));
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(stellarLib.sendStellarPayment).toHaveBeenCalledTimes(1);
        expect(stellarLib.sendStellarPayment).toHaveBeenCalledWith(
            expect.any(String), expect.any(String), freelancerWallet, "1000", expect.any(String)
        );
    });

    it('should handle partial collaborator payment failures', async () => {
        const invoiceId = 'inv_789';
        const freelancerWallet = 'G_FREELANCER';

        vi.mocked(shared.getAuthContext).mockResolvedValue({ email: 'client@example.com', user: {} } as any);
        vi.mocked(shared.EscrowReleaseSchema.safeParse).mockReturnValue({
            success: true,
            data: { invoiceId, clientEmail: 'client@example.com' }
        } as any);

        const mockInvoice = {
            id: invoiceId,
            amount: 1000,
            clientEmail: 'client@example.com',
            escrowEnabled: true,
            escrowStatus: 'held',
            invoiceNumber: 'INV-003',
            user: { wallet: { address: freelancerWallet }, email: 'free@example.com' },
            collaborators: [{ id: 'col_1' }, { id: 'col_2' }],
        };

        vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice as any);
        vi.mocked(prisma.invoice.updateMany).mockResolvedValue({ count: 1 } as any);

        vi.mocked(waterfallLib.processWaterfallPayments).mockResolvedValue({
            processed: true,
            leadShare: 500,
            distributions: [
                {
                    subContractorId: 'sub_1',
                    email: 'sub1@example.com',
                    walletAddress: 'G_SUB1',
                    sharePercentage: 20,
                    amount: 200,
                    status: 'completed',
                },
                {
                    subContractorId: 'sub_2',
                    email: 'sub2@example.com',
                    walletAddress: '', // no wallet — will fail
                    sharePercentage: 30,
                    amount: 300,
                    status: 'failed',
                    error: 'No wallet found'
                }
            ]
        } as any);

        const res = await releaseRoute(mockRequest({ invoiceId, clientEmail: 'client@example.com' }));
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.distributions).toHaveLength(2);
        expect(data.distributions[0].status).toBe('completed');
        expect(data.distributions[1].status).toBe('failed');
    });
});
