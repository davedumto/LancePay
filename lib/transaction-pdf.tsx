
import { Document, Page, Text, View, StyleSheet, Image } from '@react-pdf/renderer'
import { formatCurrency, formatNaira } from './utils'

const styles = StyleSheet.create({
    page: {
        padding: 30,
        fontSize: 10,
        fontFamily: 'Helvetica',
        backgroundColor: '#ffffff',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 20,
        alignItems: 'center',
        borderBottomWidth: 1,
        borderBottomColor: '#e5e7eb',
        paddingBottom: 20,
    },
    brand: {
        flexDirection: 'column',
    },
    logo: {
        fontSize: 20,
        fontWeight: 'bold',
        color: '#111827',
    },
    reportTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#111827',
        marginBottom: 4,
    },
    reportSubtitle: {
        fontSize: 10,
        color: '#6b7280',
    },
    summarySection: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 20,
        backgroundColor: '#f9fafb',
        padding: 15,
        borderRadius: 8,
    },
    summaryItem: {
        flexDirection: 'column',
    },
    summaryLabel: {
        fontSize: 8,
        color: '#6b7280',
        textTransform: 'uppercase',
        marginBottom: 4,
    },
    summaryValue: {
        fontSize: 14,
        fontWeight: 'bold',
        color: '#111827',
    },
    table: {
        width: '100%',
        borderWidth: 1,
        borderColor: '#e5e7eb',
        borderRadius: 4,
    },
    tableHeader: {
        flexDirection: 'row',
        backgroundColor: '#f3f4f6',
        borderBottomWidth: 1,
        borderBottomColor: '#e5e7eb',
        padding: 8,
    },
    tableRow: {
        flexDirection: 'row',
        borderBottomWidth: 1,
        borderBottomColor: '#e5e7eb',
        padding: 8,
        alignItems: 'center',
    },
    colDate: { width: '15%' },
    colType: { width: '15%' },
    colDesc: { width: '40%' },
    colAmount: { width: '15%', textAlign: 'right' },
    colStatus: { width: '15%', textAlign: 'right' },

    textSmall: { fontSize: 8, color: '#4b5563' },
    textBold: { fontWeight: 'bold', color: '#111827' },
    textPositive: { color: '#059669' },
    textNegative: { color: '#dc2626' },

    footer: {
        position: 'absolute',
        bottom: 30,
        left: 30,
        right: 30,
        textAlign: 'center',
        color: '#9ca3af',
        fontSize: 8,
        borderTopWidth: 1,
        borderTopColor: '#e5e7eb',
        paddingTop: 10,
    },
})

export interface TransactionExportData {
    dateRange: string
    generatedAt: string
    user: {
        name: string
        email: string
    }
    summary: {
        totalIncoming: number
        totalOutgoing: number
        netVolume: number
        currency: string
    }
    transactions: {
        date: string
        type: string
        description: string
        amount: number
        currency: string
        status: string
        isIncoming: boolean
    }[]
}

export const TransactionHistoryPDF = ({ data }: { data: TransactionExportData }) => {
    return (
        <Document>
            <Page size="A4" style={styles.page}>
                {/* Header */}
                <View style={styles.header}>
                    <View style={styles.brand}>
                        <Text style={styles.logo}>LancePay</Text>
                        <Text style={styles.reportSubtitle}>Transaction History</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                        <Text style={styles.reportTitle}>{data.user.name}</Text>
                        <Text style={styles.reportSubtitle}>{data.user.email}</Text>
                        <Text style={[styles.reportSubtitle, { marginTop: 4 }]}>{data.dateRange}</Text>
                    </View>
                </View>

                {/* Summary */}
                <View style={styles.summarySection}>
                    <View style={styles.summaryItem}>
                        <Text style={styles.summaryLabel}>Total Incoming</Text>
                        <Text style={[styles.summaryValue, styles.textPositive]}>
                            +{formatCurrency(data.summary.totalIncoming, data.summary.currency)}
                        </Text>
                    </View>
                    <View style={styles.summaryItem}>
                        <Text style={styles.summaryLabel}>Total Outgoing</Text>
                        <Text style={[styles.summaryValue, styles.textNegative]}>
                            {formatCurrency(Math.abs(data.summary.totalOutgoing), data.summary.currency)}
                        </Text>
                    </View>
                    <View style={styles.summaryItem}>
                        <Text style={styles.summaryLabel}>Net Volume</Text>
                        <Text style={styles.summaryValue}>
                            {formatCurrency(data.summary.netVolume, data.summary.currency)}
                        </Text>
                    </View>
                </View>

                {/* Transactions Table */}
                <View style={styles.table}>
                    <View style={styles.tableHeader}>
                        <Text style={[styles.colDate, styles.textBold]}>Date</Text>
                        <Text style={[styles.colType, styles.textBold]}>Type</Text>
                        <Text style={[styles.colDesc, styles.textBold]}>Description</Text>
                        <Text style={[styles.colAmount, styles.textBold]}>Amount</Text>
                        <Text style={[styles.colStatus, styles.textBold]}>Status</Text>
                    </View>

                    {data.transactions.map((tx, i) => (
                        <View key={i} style={styles.tableRow}>
                            <Text style={[styles.colDate, styles.textSmall]}>
                                {new Date(tx.date).toLocaleDateString()}
                            </Text>
                            <Text style={[styles.colType, styles.textSmall, { textTransform: 'capitalize' }]}>
                                {tx.type.replace('_', ' ')}
                            </Text>
                            <Text style={[styles.colDesc, styles.textSmall]}>
                                {tx.description}
                            </Text>
                            <Text
                                style={[
                                    styles.colAmount,
                                    styles.textSmall,
                                    styles.textBold,
                                    tx.isIncoming ? styles.textPositive : styles.textNegative
                                ]}
                            >
                                {tx.isIncoming ? '+' : '-'}{formatCurrency(Math.abs(tx.amount), tx.currency)}
                            </Text>
                            <Text style={[styles.colStatus, styles.textSmall, { textTransform: 'capitalize' }]}>
                                {tx.status}
                            </Text>
                        </View>
                    ))}
                </View>

                {/* Footer */}
                <View style={styles.footer}>
                    <Text>
                        Generated on {new Date(data.generatedAt).toLocaleString()} • This document is for information purposes only.
                    </Text>
                </View>
            </Page>
        </Document>
    )
}
