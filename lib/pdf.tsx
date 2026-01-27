import { Document, Page, Text, View, StyleSheet, Image } from '@react-pdf/renderer'

const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontSize: 12,
    fontFamily: 'Helvetica',
    backgroundColor: '#ffffff',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 40,
    alignItems: 'center',
  },
  logo: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#111827',
  },
  logoImage: {
    width: 60,
    height: 'auto',
    maxHeight: 60,
  },
  invoiceTitle: {
    fontSize: 32,
    fontWeight: 'bold',
    textAlign: 'right',
  },
  invoiceNumber: {
    fontSize: 12,
    color: '#6b7280',
    textAlign: 'right',
    marginTop: 4,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 10,
    color: '#6b7280',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  label: {
    color: '#6b7280',
  },
  value: {
    color: '#111827',
    fontWeight: 'bold',
  },
  divider: {
    borderBottomWidth: 1,
    marginVertical: 20,
  },
  descriptionBox: {
    backgroundColor: '#f9fafb',
    padding: 16,
    borderRadius: 8,
    marginBottom: 24,
  },
  descriptionTitle: {
    fontSize: 10,
    color: '#6b7280',
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  description: {
    color: '#374151',
    lineHeight: 1.5,
  },
  amountSection: {
    marginTop: 20,
    padding: 20,
    backgroundColor: '#f9fafb',
    borderRadius: 8,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  totalLabel: {
    fontSize: 14,
    color: '#374151',
  },
  totalAmount: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#111827',
  },
  statusBadge: {
    marginTop: 12,
    padding: 8,
    borderRadius: 4,
    alignSelf: 'flex-start',
  },
  statusPaid: {
    backgroundColor: '#d1fae5',
    color: '#065f46',
  },
  statusPending: {
    backgroundColor: '#fef3c7',
    color: '#92400e',
  },
  footer: {
    position: 'absolute',
    bottom: 40,
    left: 40,
    right: 40,
    textAlign: 'center',
    color: '#9ca3af',
    fontSize: 10,
  },
  customFooter: {
    marginTop: 10,
    color: '#6b7280',
    fontSize: 9,
    fontStyle: 'italic',
  },
  paymentInfo: {
    marginTop: 24,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
  },
  paymentTitle: {
    fontSize: 12,
    fontWeight: 'bold',
    marginBottom: 8,
    color: '#374151',
  },
  signatureBox: {
    marginTop: 40,
    alignItems: 'flex-end',
  },
  signatureImage: {
    width: 120,
    height: 'auto',
    maxHeight: 60,
    marginBottom: 8,
  },
  signatureLine: {
    width: 150,
    borderBottomWidth: 1,
    borderBottomColor: '#111827',
    marginBottom: 4,
  },
  signatureLabel: {
    fontSize: 10,
    color: '#6b7280',
  }
})

interface InvoiceData {
  invoiceNumber: string
  freelancerName: string
  freelancerEmail: string
  clientName: string
  clientEmail: string
  description: string
  amount: number
  currency: string
  status: string
  dueDate?: string | null
  createdAt: string
  paidAt?: string | null
  paymentLink: string
}

interface BrandingData {
  logoUrl?: string | null
  primaryColor?: string
  footerText?: string | null
  signatureUrl?: string | null
}

export function InvoicePDF({ invoice, branding }: { invoice: InvoiceData, branding?: BrandingData }) {
  const isPaid = invoice.status === 'paid'
  const primaryColor = branding?.primaryColor || '#6366f1'
  
  const formattedDate = new Date(invoice.createdAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  const formattedDueDate = invoice.dueDate 
    ? new Date(invoice.dueDate).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            {branding?.logoUrl ? (
              /* eslint-disable-next-line jsx-a11y/alt-text */
              <Image src={branding.logoUrl} style={styles.logoImage} cache={false} />
            ) : (
              <Text style={styles.logo}>LancePay</Text>
            )}
          </View>
          <View>
            <Text style={[styles.invoiceTitle, { color: primaryColor }]}>INVOICE</Text>
            <Text style={styles.invoiceNumber}>{invoice.invoiceNumber}</Text>
          </View>
        </View>

        {/* From / To */}
        <View style={{ flexDirection: 'row', marginBottom: 24 }}>
          <View style={{ flex: 1 }}>
            <Text style={styles.sectionTitle}>From</Text>
            <Text style={styles.value}>{invoice.freelancerName}</Text>
            <Text style={styles.label}>{invoice.freelancerEmail}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.sectionTitle}>Bill To</Text>
            <Text style={styles.value}>{invoice.clientName || 'Client'}</Text>
            <Text style={styles.label}>{invoice.clientEmail}</Text>
          </View>
        </View>

        {/* Dates */}
        <View style={styles.section}>
          <View style={styles.row}>
            <Text style={styles.label}>Invoice Date:</Text>
            <Text style={styles.value}>{formattedDate}</Text>
          </View>
          {formattedDueDate && (
            <View style={styles.row}>
              <Text style={styles.label}>Due Date:</Text>
              <Text style={styles.value}>{formattedDueDate}</Text>
            </View>
          )}
        </View>

        <View style={[styles.divider, { borderBottomColor: primaryColor }]} />

        {/* Description */}
        <View style={styles.descriptionBox}>
          <Text style={styles.descriptionTitle}>Description</Text>
          <Text style={styles.description}>{invoice.description}</Text>
        </View>

        {/* Amount */}
        <View style={styles.amountSection}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total Amount</Text>
            <Text style={styles.totalAmount}>
              ${invoice.amount.toFixed(2)} {invoice.currency}
            </Text>
          </View>
          <View style={[styles.statusBadge, isPaid ? styles.statusPaid : styles.statusPending]}>
            <Text>{isPaid ? '✓ PAID' : '○ PENDING'}</Text>
          </View>
        </View>

        {/* Payment Info */}
        {!isPaid && (
          <View style={styles.paymentInfo}>
            <Text style={styles.paymentTitle}>Payment Instructions</Text>
            <Text style={styles.label}>
              Pay online at: {invoice.paymentLink}
            </Text>
          </View>
        )}

        {/* Signature */}
        {(branding?.signatureUrl || branding?.footerText) && (
          <View style={styles.signatureBox}>
            {branding?.signatureUrl && (
              /* eslint-disable-next-line jsx-a11y/alt-text */
              <Image src={branding.signatureUrl} style={styles.signatureImage} cache={false} />
            )}
            <View style={styles.signatureLine} />
            <Text style={styles.signatureLabel}>Authorized Signature</Text>
          </View>
        )}

        {/* Footer */}
        <View style={styles.footer}>
          <Text>Generated by LancePay • {new Date().toLocaleDateString()}</Text>
          {branding?.footerText && (
            <Text style={styles.customFooter}>{branding.footerText}</Text>
          )}
        </View>
      </Page>
    </Document>
  )
}
