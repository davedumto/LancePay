import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY || 're_placeholder')

// Centralized sender identity (server-only).
// Must be a verified sender in Resend (domain or single sender).
const RESEND_FROM = process.env.RESEND_FROM || 'LancePay <onboarding@resend.dev>'

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
      from: RESEND_FROM,
      to: [to],
      subject: `Payment Received - ${invoiceNumber}`,
      html: `
        <div style="font-family: system-ui, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #111;">Hey ${freelancerName}!</h2>
          <p>You received a payment for invoice <strong>${invoiceNumber}</strong>.</p>
          <div style="background:#ECFDF5;border:1px solid #A7F3D0;color:#065F46;padding:24px;border-radius:12px;text-align:center;margin:20px 0;">
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

interface AdminAlertParams {
  subject: string
  message: string
  severity?: 'warning' | 'critical'
  context?: Record<string, unknown>
  actionRequired?: string
}

export async function sendAdminAlertEmail(params: AdminAlertParams) {
  const to = process.env.ADMIN_ALERT_EMAIL
  if (!to) {
    console.warn('ADMIN_ALERT_EMAIL not configured; admin alert email skipped', {
      subject: params.subject,
    })
    return { success: false, skipped: true as const }
  }

  const severity = params.severity || 'warning'
  const severityLabel = severity === 'critical' ? 'CRITICAL' : 'WARNING'

  const severityBg = severity === 'critical' ? '#FEF2F2' : '#FFFBEB'
  const severityBorder = severity === 'critical' ? '#FCA5A5' : '#FCD34D'
  const severityText = severity === 'critical' ? '#991B1B' : '#92400E'

  try {
    const contextHtml = params.context
      ? `
        <div style="margin-top:16px;">
          <strong style="color:#111;">Context:</strong>
          <pre style="background:#f6f8fa;padding:12px;border-radius:8px;overflow:auto;font-size:12px;">${escapeHtml(
        JSON.stringify(params.context, null, 2)
      )}</pre>
        </div>
      `
      : ''

    const actionHtml = params.actionRequired
      ? `
        <div style="background:${severityBg};border-left:4px solid ${severityBorder};padding:12px;margin:16px 0;border-radius:4px;">
          <strong style="color:${severityText};">Action Required:</strong>
          <p style="color:${severityText};margin:4px 0 0 0;">${escapeHtml(params.actionRequired)}</p>
        </div>
      `
      : ''

    const { error } = await resend.emails.send({
      from: RESEND_FROM,
      to: [to],
      subject: `[LancePay ${severityLabel}] ${params.subject}`,
      html: `
        <div style="font-family: system-ui, sans-serif; max-width: 680px; margin: 0 auto; padding: 24px;">
          <div style="margin-bottom:14px;">
            <span style="display:inline-block;background:${severityBg};border:1px solid ${severityBorder};color:${severityText};padding:6px 12px;border-radius:8px;font-size:12px;line-height:1;font-weight:700;letter-spacing:0.3px;">
              ${severityLabel}
            </span>
          </div>
          
          <h2 style="color:#111;margin:0 0 12px 0;">${escapeHtml(params.subject)}</h2>
          <p style="color:#333;line-height:1.5;">${escapeHtml(params.message)}</p>
          ${actionHtml}
          ${contextHtml}
          <p style="color:#666;font-size:12px;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:12px;">
            Automated alert from LancePay operations
          </p>
        </div>
      `,
    })

    if (error) {
      console.error('Admin alert email failed', { error })
      return { success: false }
    }
    return { success: true }
  } catch (error) {
    console.error('Admin alert email threw', {
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return { success: false }
  }
}

/**
 * Basic HTML entity escaping for dynamic fields rendered into the email template.
 * Prevents unintended HTML interpretation and reduces injection risk in operational emails.
 */
function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}


export async function sendEmail(params: { to: string; subject: string; template?: string; html?: string }) {
  const { to, subject, template, html } = params
  const htmlContent = html || template || ''

  try {
    const { error } = await resend.emails.send({
      from: RESEND_FROM,
      to: [to],
      subject,
      html: htmlContent,
    })

    if (error) console.error('Email error:', error)
    return { success: !error }
  } catch (error) {
    console.error('Email send failed:', error)
    return { success: false }
  }
}

// Invoice created email
export async function sendInvoiceCreatedEmail(params: {
  to: string
  clientName?: string
  freelancerName?: string
  invoiceNumber: string
  description?: string
  amount: number
  currency: string
  paymentLink: string
  dueDate?: Date | null
}) {
  const dueDateStr = params.dueDate ? new Date(params.dueDate).toLocaleDateString() : null
  return sendEmail({
    to: params.to,
    subject: `Invoice ${params.invoiceNumber} from LancePay`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
        <h2>Invoice ${params.invoiceNumber}</h2>
        <p>Hi ${params.clientName || 'there'},</p>
        <p>You have received an invoice for <strong>$${params.amount.toFixed(2)} ${params.currency}</strong>.</p>
        ${params.description ? `<p><strong>Description:</strong> ${params.description}</p>` : ''}
        ${dueDateStr ? `<p><strong>Due Date:</strong> ${dueDateStr}</p>` : ''}
        <a href="${params.paymentLink}" style="display: inline-block; background: #10b981; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none;">Pay Now</a>
        <p style="color: #666; font-size: 12px; margin-top: 20px;">LancePay - Get paid globally, withdraw locally</p>
      </div>
    `,
  })
}


// Escrow released email
export async function sendEscrowReleasedEmail(params: {
  to: string
  freelancerName?: string
  invoiceNumber: string
  amount?: number
  clientEmail?: string
  notes?: string
}) {
  return sendEmail({
    to: params.to,
    subject: `✅ Escrow Released - ${params.invoiceNumber}`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
        <h2>Escrow Released! 🎉</h2>
        <p>Hi ${params.freelancerName || 'there'},</p>
        <p>The escrow for invoice <strong>${params.invoiceNumber}</strong> has been released.</p>
        ${params.amount ? `
        <div style="background: #10b981; color: white; padding: 24px; border-radius: 12px; text-align: center; margin: 20px 0;">
          <div style="font-size: 32px; font-weight: bold;">$${params.amount.toFixed(2)}</div>
          <div>USDC</div>
        </div>` : ''}
        ${params.clientEmail ? `<p><strong>Released by:</strong> ${params.clientEmail}</p>` : ''}
        ${params.notes ? `<p><strong>Notes:</strong> ${params.notes}</p>` : ''}
        <p style="color: #666; font-size: 12px; margin-top: 20px;">LancePay - Get paid globally, withdraw locally</p>
      </div>
    `,
  })
}


// Escrow disputed email
export async function sendEscrowDisputedEmail(params: {
  to: string
  name?: string
  invoiceNumber: string
  reason: string
  clientEmail?: string
  requestedAction?: string
}) {
  return sendEmail({
    to: params.to,
    subject: `⚠️ Escrow Disputed - ${params.invoiceNumber}`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
        <h2>Escrow Dispute Filed</h2>
        <p>Hi ${params.name || 'there'},</p>
        <p>A dispute has been filed for invoice <strong>${params.invoiceNumber}</strong>.</p>
        ${params.clientEmail ? `<p><strong>Client:</strong> ${params.clientEmail}</p>` : ''}
        <p><strong>Reason:</strong> ${params.reason}</p>
        ${params.requestedAction ? `<p><strong>Requested action:</strong> ${params.requestedAction}</p>` : ''}
        <p style="color: #666; font-size: 12px;">LancePay - Get paid globally, withdraw locally</p>
      </div>
    `,
  })
}

// Dispute created email
export async function sendDisputeCreatedEmail(params: {
  to: string
  name: string
  invoiceNumber: string
  reason: string
}) {
  return sendEscrowDisputedEmail(params)
}

export async function sendDisputeResolvedEmail(params: {
  to: string
  name?: string
  invoiceNumber: string
  resolution: string
  action?: string
  refundAmount?: number
  currency?: string
}) {
  const refundText = params.action === 'refund_partial' && params.refundAmount
    ? `<p><strong>Refund Amount:</strong> $${params.refundAmount.toFixed(2)} ${params.currency || 'USD'}</p>`
    : ''

  return sendEmail({
    to: params.to,
    subject: `✅ Dispute Resolved - ${params.invoiceNumber}`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
        <h2>Dispute Resolved</h2>
        <p>Hi ${params.name || 'there'},</p>
        <p>The dispute for invoice <strong>${params.invoiceNumber}</strong> has been resolved.</p>
        <p><strong>Resolution:</strong> ${params.resolution}</p>
        ${params.action ? `<p><strong>Action:</strong> ${params.action}</p>` : ''}
        ${refundText}
        <p style="color: #666; font-size: 12px;">LancePay - Get paid globally, withdraw locally</p>
      </div>
    `,
  })
}

// Dispute responded email
export async function sendDisputeRespondedEmail(params: {
  to: string
  name: string
  invoiceNumber: string
  response: string
}) {
  return sendEmail({
    to: params.to,
    subject: `💬 Dispute Response - ${params.invoiceNumber}`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
        <h2>Dispute Response</h2>
        <p>Hi ${params.name},</p>
        <p>A response has been made to the dispute for invoice <strong>${params.invoiceNumber}</strong>.</p>
        <p><strong>Response:</strong> ${params.response}</p>
        <p style="color: #666; font-size: 12px;">LancePay - Get paid globally, withdraw locally</p>
      </div>
    `,
  })
}

// Dispute initiated email
export async function sendDisputeInitiatedEmail(params: {
  to: string
  name?: string
  invoiceNumber: string
  reason: string
  initiatedBy?: string
  requestedAction?: string
}) {
  return sendEmail({
    to: params.to,
    subject: `⚠️ Dispute Filed - ${params.invoiceNumber}`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
        <h2>Dispute Filed</h2>
        <p>Hi ${params.name || 'there'},</p>
        <p>A dispute has been filed for invoice <strong>${params.invoiceNumber}</strong>.</p>
        ${params.initiatedBy ? `<p><strong>Filed by:</strong> ${params.initiatedBy}</p>` : ''}
        <p><strong>Reason:</strong> ${params.reason}</p>
        ${params.requestedAction ? `<p><strong>Requested action:</strong> ${params.requestedAction}</p>` : ''}
        <p style="color: #666; font-size: 12px;">LancePay - Get paid globally, withdraw locally</p>
      </div>
    `,
  })
}

// Dispute message email
export async function sendDisputeMessageEmail(params: {
  to: string
  name?: string
  invoiceNumber: string
  message: string
  senderType?: string
}) {
  return sendEmail({
    to: params.to,
    subject: `💬 New Dispute Message - ${params.invoiceNumber}`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
        <h2>New Dispute Message</h2>
        <p>Hi ${params.name || 'there'},</p>
        <p>A new message has been posted to the dispute for invoice <strong>${params.invoiceNumber}</strong>.</p>
        ${params.senderType ? `<p><strong>From:</strong> ${params.senderType}</p>` : ''}
        <div style="background: #f3f4f6; padding: 16px; border-radius: 8px; margin: 16px 0;">
          <p style="margin: 0;">${params.message}</p>
        </div>
        <p style="color: #666; font-size: 12px;">LancePay - Get paid globally, withdraw locally</p>
      </div>
    `,
  })
}

// Invoice chat message email
export async function sendInvoiceMessageEmail(params: {
  to: string
  name?: string
  invoiceNumber: string
  message: string
  senderName: string
}) {
  return sendEmail({
    to: params.to,
    subject: `💬 New Message on Invoice ${params.invoiceNumber}`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
        <h2>New Message</h2>
        <p>Hi ${params.name || 'there'},</p>
        <p>You have a new message on invoice <strong>${params.invoiceNumber}</strong>.</p>
        <p><strong>From:</strong> ${params.senderName}</p>
        <div style="background: #f3f4f6; padding: 16px; border-radius: 8px; margin: 16px 0;">
          <p style="margin: 0;">${params.message}</p>
        </div>
        <p style="color: #666; font-size: 12px;">LancePay - Get paid globally, withdraw locally</p>
      </div>
    `,
  })
}

