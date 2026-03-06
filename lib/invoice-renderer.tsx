import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer'

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
    marginBottom: 36,
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
    fontSize: 30,
    fontWeight: 'bold',
    textAlign: 'right',
  },
  invoiceNumber: {
    fontSize: 12,
    color: '#6b7280',
    textAlign: 'right',
    marginTop: 4,
  },
  sectionTitle: {
    fontSize: 10,
    color: '#6b7280',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  label: {
    color: '#6b7280',
  },
  value: {
    color: '#111827',
    fontWeight: 'bold',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
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
  },
  statusPending: {
    backgroundColor: '#fef3c7',
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
})

export interface InvoiceData {
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

export interface InvoiceTemplateConfig {
  id?: string
  name?: string
  logoUrl?: string | null
  primaryColor?: string
  accentColor?: string
  showLogo?: boolean
  showFooter?: boolean
  footerText?: string | null
  layout?: 'modern' | 'classic' | 'minimal'
  signatureUrl?: string | null
}

interface LegacyBrandingConfig {
  logoUrl?: string | null
  primaryColor?: string
  footerText?: string | null
  signatureUrl?: string | null
}

function resolveTemplateOptions(template?: InvoiceTemplateConfig, branding?: LegacyBrandingConfig) {
  const layout = template?.layout ?? 'modern'
  const primaryColor = template?.primaryColor || branding?.primaryColor || '#6366f1'
  const accentColor = template?.accentColor || primaryColor
  const logoUrl = template?.logoUrl ?? branding?.logoUrl ?? null
  const showLogo = template?.showLogo ?? !!logoUrl
  const showFooter = template?.showFooter ?? true
  const footerText = template?.footerText ?? branding?.footerText ?? null
  const signatureUrl = template?.signatureUrl ?? branding?.signatureUrl ?? null

  return {
    layout,
    primaryColor,
    accentColor,
    logoUrl,
    showLogo,
    showFooter,
    footerText,
    signatureUrl,
  }
}

export function InvoicePDF({
  invoice,
  template,
  branding,
}: {
  invoice: InvoiceData
  template?: InvoiceTemplateConfig
  branding?: LegacyBrandingConfig
}) {
  const isPaid = invoice.status === 'paid'
  const {
    layout,
    primaryColor,
    accentColor,
    logoUrl,
    showLogo,
    showFooter,
    footerText,
    signatureUrl,
  } = resolveTemplateOptions(template, branding)

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

  const headerStyle =
    layout === 'classic'
      ? { borderBottomWidth: 1, borderBottomColor: primaryColor, paddingBottom: 14 }
      : layout === 'minimal'
        ? { marginBottom: 24 }
        : {}

  const amountStyle =
    layout === 'minimal'
      ? { backgroundColor: '#ffffff', borderWidth: 1, borderColor: '#e5e7eb' }
      : {}

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={[styles.header, headerStyle]}>
          <View>
            {showLogo && logoUrl ? (
              /* eslint-disable-next-line jsx-a11y/alt-text */
              <Image src={logoUrl} style={styles.logoImage} cache={false} />
            ) : (
              <Text style={[styles.logo, { color: accentColor }]}>LancePay</Text>
            )}
          </View>
          <View>
            <Text style={[styles.invoiceTitle, { color: primaryColor }]}>INVOICE</Text>
            <Text style={styles.invoiceNumber}>{invoice.invoiceNumber}</Text>
          </View>
        </View>

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

        <View style={{ marginBottom: 24 }}>
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

        <View style={styles.descriptionBox}>
          <Text style={styles.sectionTitle}>Description</Text>
          <Text style={styles.description}>{invoice.description}</Text>
        </View>

        <View style={[styles.amountSection, amountStyle]}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total Amount</Text>
            <Text style={styles.totalAmount}>
              ${invoice.amount.toFixed(2)} {invoice.currency}
            </Text>
          </View>
          <View
            style={[
              styles.statusBadge,
              isPaid ? styles.statusPaid : styles.statusPending,
              { borderWidth: 0.5, borderColor: accentColor },
            ]}
          >
            <Text>{isPaid ? '✓ PAID' : '○ PENDING'}</Text>
          </View>
        </View>

        {!isPaid && (
          <View style={styles.paymentInfo}>
            <Text style={styles.paymentTitle}>Payment Instructions</Text>
            <Text style={styles.label}>Pay online at: {invoice.paymentLink}</Text>
          </View>
        )}

        {(signatureUrl || footerText) && (
          <View style={styles.signatureBox}>
            {signatureUrl && (
              /* eslint-disable-next-line jsx-a11y/alt-text */
              <Image src={signatureUrl} style={styles.signatureImage} cache={false} />
            )}
            <View style={styles.signatureLine} />
            <Text style={styles.signatureLabel}>Authorized Signature</Text>
          </View>
        )}

        {showFooter && (
          <View style={styles.footer}>
            <Text>Generated by LancePay • {new Date().toLocaleDateString()}</Text>
            {footerText && <Text style={styles.customFooter}>{footerText}</Text>}
          </View>
        )}
      </Page>
    </Document>
  )
}
