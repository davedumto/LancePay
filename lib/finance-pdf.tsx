import React from 'react'
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'

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
    marginBottom: 30,
    paddingBottom: 20,
    borderBottomWidth: 2,
    borderBottomColor: '#6366f1',
  },
  logo: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#6366f1',
  },
  reportTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#111827',
    textAlign: 'right',
  },
  reportSubtitle: {
    fontSize: 11,
    color: '#6b7280',
    textAlign: 'right',
    marginTop: 4,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#374151',
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  periodBox: {
    backgroundColor: '#f3f4f6',
    padding: 12,
    borderRadius: 6,
    marginBottom: 24,
  },
  periodText: {
    fontSize: 14,
    color: '#111827',
    fontWeight: 'bold',
  },
  dateRangeText: {
    fontSize: 10,
    color: '#6b7280',
    marginTop: 4,
  },
  table: {
    marginBottom: 16,
  },
  tableRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  tableRowSubitem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  tableRowTotal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: '#f9fafb',
    marginTop: 8,
    borderRadius: 4,
  },
  tableRowProfit: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 16,
    paddingHorizontal: 12,
    backgroundColor: '#dbeafe',
    marginTop: 12,
    borderRadius: 4,
  },
  labelText: {
    fontSize: 11,
    color: '#374151',
  },
  labelTextBold: {
    fontSize: 11,
    color: '#111827',
    fontWeight: 'bold',
  },
  labelTextSubitem: {
    fontSize: 10,
    color: '#6b7280',
    fontStyle: 'italic',
  },
  valueText: {
    fontSize: 11,
    color: '#374151',
    textAlign: 'right',
  },
  valueTextBold: {
    fontSize: 11,
    color: '#111827',
    fontWeight: 'bold',
    textAlign: 'right',
  },
  valueTextProfit: {
    fontSize: 16,
    color: '#1e40af',
    fontWeight: 'bold',
    textAlign: 'right',
  },
  valueTextNegative: {
    fontSize: 11,
    color: '#dc2626',
    textAlign: 'right',
  },
  divider: {
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    marginVertical: 20,
  },
  clientTable: {
    marginTop: 12,
  },
  clientHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#f3f4f6',
    borderRadius: 4,
    marginBottom: 4,
  },
  clientHeaderText: {
    fontSize: 9,
    color: '#6b7280',
    fontWeight: 'bold',
    textTransform: 'uppercase',
  },
  clientRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  clientName: {
    fontSize: 10,
    color: '#111827',
    fontWeight: 'bold',
    flex: 2,
  },
  clientEmail: {
    fontSize: 9,
    color: '#6b7280',
    flex: 2,
  },
  clientRevenue: {
    fontSize: 10,
    color: '#374151',
    textAlign: 'right',
    flex: 1,
  },
  footer: {
    position: 'absolute',
    bottom: 30,
    left: 40,
    right: 40,
    textAlign: 'center',
    color: '#9ca3af',
    fontSize: 9,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  emptyState: {
    padding: 20,
    textAlign: 'center',
    color: '#6b7280',
    fontSize: 11,
    fontStyle: 'italic',
  },
  infoBox: {
    backgroundColor: '#fef3c7',
    padding: 12,
    borderRadius: 4,
    marginTop: 16,
  },
  infoText: {
    fontSize: 9,
    color: '#92400e',
    lineHeight: 1.4,
  },
})

interface PLReport {
  period: string
  dateRange: {
    start: string
    end: string
  }
  summary: {
    totalIncome: number
    platformFees: number
    withdrawalFees: number
    operatingExpenses: number
    netProfit: number
  }
  topClients: Array<{
    name: string
    email: string
    revenue: number
  }>
  currency: string
  freelancer: {
    name: string
    email: string
  }
}

export function FinancePDF({ report }: { report: PLReport }) {
  const formatCurrency = (amount: number) => {
    return `$${amount.toFixed(2)}`
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  const hasActivity = report.summary.totalIncome > 0 || report.summary.operatingExpenses > 0
  const profitIsPositive = report.summary.netProfit >= 0

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.logo}>LancePay</Text>
          </View>
          <View>
            <Text style={styles.reportTitle}>PROFIT & LOSS STATEMENT</Text>
            <Text style={styles.reportSubtitle}>Financial Report</Text>
          </View>
        </View>

        {/* Freelancer Info */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Prepared For</Text>
          <Text style={styles.labelTextBold}>{report.freelancer.name}</Text>
          <Text style={styles.labelText}>{report.freelancer.email}</Text>
        </View>

        {/* Period */}
        <View style={styles.periodBox}>
          <Text style={styles.periodText}>Period: {report.period}</Text>
          <Text style={styles.dateRangeText}>
            {formatDate(report.dateRange.start)} - {formatDate(report.dateRange.end)}
          </Text>
        </View>

        {/* Income Statement */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Income Statement</Text>

          {hasActivity ? (
            <View style={styles.table}>
              {/* Revenue */}
              <View style={styles.tableRow}>
                <Text style={styles.labelTextBold}>Revenue</Text>
                <Text style={styles.valueTextBold}>
                  {formatCurrency(report.summary.totalIncome)}
                </Text>
              </View>

              {/* Less: Platform Fees */}
              <View style={styles.tableRowSubitem}>
                <Text style={styles.labelTextSubitem}>Less: Platform Fees (0.5%)</Text>
                <Text style={styles.valueTextNegative}>
                  ({formatCurrency(report.summary.platformFees)})
                </Text>
              </View>

              {/* Less: Withdrawal Fees */}
              <View style={styles.tableRowSubitem}>
                <Text style={styles.labelTextSubitem}>Less: Withdrawal Fees (0.5%)</Text>
                <Text style={styles.valueTextNegative}>
                  ({formatCurrency(report.summary.withdrawalFees)})
                </Text>
              </View>

              {/* Operating Expenses */}
              <View style={styles.tableRow}>
                <Text style={styles.labelTextBold}>Operating Expenses (Withdrawals)</Text>
                <Text style={styles.valueTextNegative}>
                  ({formatCurrency(report.summary.operatingExpenses)})
                </Text>
              </View>

              {/* Net Profit */}
              <View style={styles.tableRowProfit}>
                <Text style={styles.labelTextBold}>NET PROFIT</Text>
                <Text
                  style={
                    profitIsPositive
                      ? styles.valueTextProfit
                      : { ...styles.valueTextProfit, color: '#dc2626' }
                  }
                >
                  {formatCurrency(report.summary.netProfit)}
                </Text>
              </View>
            </View>
          ) : (
            <View style={styles.emptyState}>
              <Text>No financial activity recorded for this period.</Text>
            </View>
          )}
        </View>

        {/* Top Clients Section */}
        {report.topClients.length > 0 && (
          <>
            <View style={styles.divider} />
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Top Clients by Revenue</Text>

              <View style={styles.clientTable}>
                <View style={styles.clientHeader}>
                  <Text style={[styles.clientHeaderText, { flex: 2 }]}>Client Name</Text>
                  <Text style={[styles.clientHeaderText, { flex: 2 }]}>Email</Text>
                  <Text style={[styles.clientHeaderText, { flex: 1, textAlign: 'right' }]}>
                    Revenue
                  </Text>
                </View>

                {report.topClients.map((client, index) => (
                  <View key={index} style={styles.clientRow}>
                    <Text style={styles.clientName}>{client.name}</Text>
                    <Text style={styles.clientEmail}>{client.email}</Text>
                    <Text style={styles.clientRevenue}>{formatCurrency(client.revenue)}</Text>
                  </View>
                ))}
              </View>
            </View>
          </>
        )}

        {/* Info Box */}
        <View style={styles.infoBox}>
          <Text style={styles.infoText}>
            This financial statement has been prepared based on transaction data from LancePay.
            Platform fees (0.5%) and withdrawal fees (0.5%) are calculated estimates. All amounts
            are in {report.currency}.
          </Text>
        </View>

        {/* Footer */}
        <Text style={styles.footer}>
          Generated by LancePay • {new Date().toLocaleDateString('en-US')} •
          www.lancepay.io
        </Text>
      </Page>
    </Document>
  )
}
