import * as React from 'react'

export interface InvoiceBrandingProps {
  logoUrl?: string | null
  primaryColor?: string
  accentColor?: string
  footerText?: string | null
}

export interface InvoiceAutoCancelledEmailProps {
  freelancerName: string
  invoiceNumber: string
  amount: number
  dueDate: Date
  daysOverdue: number
  clientEmail: string
  branding?: InvoiceBrandingProps
}

export const InvoiceAutoCancelledEmail: React.FC<InvoiceAutoCancelledEmailProps> = ({
  freelancerName,
  invoiceNumber,
  amount,
  dueDate,
  daysOverdue,
  clientEmail,
  branding,
}) => {
  const primary = branding?.primaryColor || '#111'
  const accent = branding?.accentColor || '#991B1B'

  return (
    <div
      style={{
        fontFamily: 'system-ui, sans-serif',
        maxWidth: '500px',
        margin: '0 auto',
        padding: '24px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '16px' }}>
        {branding?.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={branding.logoUrl}
            alt="Brand logo"
            style={{ height: '32px', marginRight: '12px', borderRadius: '6px' }}
          />
        )}
        <h2 style={{ color: primary, margin: 0 }}>Invoice Auto-Cancelled</h2>
      </div>

      <p>Hi {freelancerName},</p>
      <p>
        Your invoice <strong>{invoiceNumber}</strong> has been automatically cancelled
        because it is {daysOverdue} days overdue.
      </p>

      <div
        style={{
          background: '#FEF2F2',
          border: `1px solid ${accent}`,
          color: accent,
          padding: '24px',
          borderRadius: '12px',
          textAlign: 'center',
          margin: '20px 0',
        }}
      >
        <div style={{ fontSize: '32px', fontWeight: 'bold' }}>${amount.toFixed(2)}</div>
        <div>USD</div>
      </div>

      <p style={{ color: '#666' }}>
        <strong>Client:</strong> {clientEmail}
      </p>
      <p style={{ color: '#666' }}>
        <strong>Due Date:</strong> {dueDate.toLocaleDateString()}
      </p>

      <p style={{ color: '#666', fontSize: '12px', marginTop: '20px' }}>
        {branding?.footerText || 'LancePay - Get paid globally, withdraw locally'}
      </p>
    </div>
  )
}

export default InvoiceAutoCancelledEmail
