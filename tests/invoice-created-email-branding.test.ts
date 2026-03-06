import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn().mockResolvedValue({ error: null }),
}))

vi.mock('resend', () => {
  class MockResend {
    emails = {
      send: sendMock,
    }
  }

  return { Resend: MockResend }
})

import { sendInvoiceCreatedEmail } from '@/lib/email'

describe('sendInvoiceCreatedEmail branding', () => {
  beforeEach(() => {
    sendMock.mockClear()
  })

  it('applies provided branding values to invoice email html', async () => {
    await sendInvoiceCreatedEmail({
      to: 'client@example.com',
      clientName: 'Client',
      freelancerName: 'Freelancer',
      invoiceNumber: 'INV-1001',
      description: 'Website design',
      amount: 500,
      currency: 'USD',
      paymentLink: 'https://example.com/pay/INV-1001',
      dueDate: new Date('2026-03-30T00:00:00Z'),
      branding: {
        primaryColor: '#1f2937',
        accentColor: '#0ea5e9',
        footerText: 'Thank you for your business!',
      },
    })

    expect(sendMock).toHaveBeenCalledTimes(1)
    const payload = sendMock.mock.calls[0][0]
    expect(payload.html).toContain('color:#1f2937')
    expect(payload.html).toContain('background: #0ea5e9')
    expect(payload.html).toContain('Thank you for your business!')
  })
})
