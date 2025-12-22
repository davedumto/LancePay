import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

interface PaymentEmailParams {
  to: string
  freelancerName: string
  clientName: string
  invoiceNumber: string
  amount: number
  currency: string
}

export async function sendPaymentReceivedEmail(params: PaymentEmailParams) {
  const { to, freelancerName, clientName, invoiceNumber, amount, currency } = params
  
  try {
    const { error } = await resend.emails.send({
      from: 'LancePay <notifications@lancepay.app>',
      to: [to],
      subject: `💰 Payment Received - ${invoiceNumber}`,
      html: `
        <div style="font-family: system-ui, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #111;">Hey ${freelancerName}! 🎉</h2>
          <p>You received a payment for invoice <strong>${invoiceNumber}</strong>.</p>
          <div style="background: #10b981; color: white; padding: 24px; border-radius: 12px; text-align: center; margin: 20px 0;">
            <div style="font-size: 32px; font-weight: bold;">$${amount.toFixed(2)}</div>
            <div>${currency}</div>
          </div>
          <p style="color: #666;">From: ${clientName}</p>
          <p style="color: #666; font-size: 12px;">LancePay - Get paid globally, withdraw locally</p>
        </div>
      `,
    })

    if (error) console.error('Email error:', error)
    return { success: !error }
  } catch (error) {
    console.error('Email send failed:', error)
    return { success: false }
  }
}
