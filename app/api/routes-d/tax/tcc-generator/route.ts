import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import {
  getTaxAuth,
  parseYearParam,
  round2,
  PLATFORM_FEE_RATE,
  getYearBounds,
} from '@/app/api/routes-d/tax-reports/_shared'
import { getUsdToNgnRate } from '@/lib/exchange-rate'
import { logger } from '@/lib/logger'

/**
 * TCC Data Generator - Tax Clearance Certificate Data Generator
 * 
 * This endpoint generates transaction data formatted for Nigerian tax filing (FIRS/LIRS).
 * It aggregates all paid invoices for a fiscal year and exports them in CSV or JSON format.
 * 
 * Endpoint: GET /api/routes-d/tax/tcc-generator
 * Query Parameters:
 *   - year: Fiscal year (e.g., 2025) - required
 *   - format: csv | json (default: csv)
 * 
 * Returns transaction data with:
 *   - Transaction Date
 *   - Client Name
 *   - Nature of Service (Invoice description)
 *   - Gross Amount (USDC)
 *   - Gross Amount (NGN Equivalent)
 *   - Tax Deducted (platform fees)
 */

interface TCCTransactionRow {
  transactionDate: string
  clientName: string
  natureOfService: string
  grossAmountUsdc: number
  grossAmountNgn: number
  taxDeducted: number
  invoiceNumber: string
}

interface TCCSummary {
  year: number
  totalGrossIncomeUsdc: number
  totalGrossIncomeNgn: number
  totalPlatformFees: number
  totalTransactions: number
  generatedAt: string
  defaultExchangeRateUsed: boolean
  exchangeRateNote: string
}

function csvEscape(value: string): string {
  if (!value) return ''
  const strVal = String(value)
  if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n') || strVal.includes('\r')) {
    return `"${strVal.replace(/"/g, '""')}"`
  }
  return strVal
}

function toCsvRow(cols: (string | number)[]): string {
  return cols.map(col => csvEscape(String(col))).join(',')
}

/**
 * Format date as YYYY-MM-DD for FIRS compatibility
 */
function formatDateForTax(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Get NGN equivalent amount using stored exchange rate or current rate
 */
async function getNgnEquivalent(
  usdcAmount: number,
  storedExchangeRate: number | null,
  storedNgnAmount: number | null
): Promise<{ ngnAmount: number; usedStoredRate: boolean }> {
  // Prefer stored NGN amount if available (most accurate for historical transactions)
  if (storedNgnAmount !== null && storedNgnAmount > 0) {
    return { ngnAmount: storedNgnAmount, usedStoredRate: true }
  }

  // Use stored exchange rate if available
  if (storedExchangeRate !== null && storedExchangeRate > 0) {
    return { 
      ngnAmount: round2(usdcAmount * storedExchangeRate), 
      usedStoredRate: true 
    }
  }

  // Fall back to current rate (with warning in response)
  const rateResult = await getUsdToNgnRate()
  return { 
    ngnAmount: round2(usdcAmount * rateResult.rate), 
    usedStoredRate: false 
  }
}

export async function GET(request: NextRequest) {
  try {
    // Authenticate user - Privacy: only account owner can generate their tax data
    const auth = await getTaxAuth(request)
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 })
    }
    if (!auth.user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Parse year parameter
    const year = parseYearParam(request)
    if (!year) {
      return NextResponse.json(
        { error: 'year is required (e.g., 2025). Valid range: 2000-2100' },
        { status: 400 }
      )
    }

    // Parse format parameter (default: csv)
    const format = (request.nextUrl.searchParams.get('format') || 'csv').toLowerCase()
    if (!['csv', 'json'].includes(format)) {
      return NextResponse.json(
        { error: 'format must be one of: csv, json' },
        { status: 400 }
      )
    }

    const { start, end } = getYearBounds(year)
    const userId = auth.user.id

    // Fetch all PAID invoices with payment dates within the requested year
    // We query transactions linked to invoices where status is 'completed'
    // and the payment (completedAt) falls within the fiscal year
    const paidTransactions = await prisma.transaction.findMany({
      where: {
        userId,
        status: 'completed',
        type: { in: ['incoming', 'payment'] }, // Income transactions
        completedAt: {
          gte: start,
          lt: end,
        },
      },
      orderBy: { completedAt: 'asc' },
      include: {
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            clientEmail: true,
            clientName: true,
            description: true,
            paidAt: true,
          },
        },
      },
    })

    // Check for empty data
    if (paidTransactions.length === 0) {
      if (format === 'json') {
        return NextResponse.json({
          message: 'No records found for the specified fiscal year',
          year,
          transactions: [],
          summary: {
            year,
            totalGrossIncomeUsdc: 0,
            totalGrossIncomeNgn: 0,
            totalPlatformFees: 0,
            totalTransactions: 0,
            generatedAt: new Date().toISOString(),
            defaultExchangeRateUsed: false,
            exchangeRateNote: 'No transactions to process',
          },
        })
      }

      // Return empty CSV template with headers
      const headers = [
        'Transaction Date',
        'Invoice Number',
        'Client Name',
        'Nature of Service',
        'Gross Amount (USDC)',
        'Gross Amount (NGN Equivalent)',
        'Tax Deducted (Platform Fee)',
      ]
      const csvContent = toCsvRow(headers)
      return new NextResponse(csvContent, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="tcc_data_${year}_empty.csv"`,
        },
      })
    }

    // Process transactions and calculate NGN equivalents
    const processedRows: TCCTransactionRow[] = []
    let totalGrossIncomeUsdc = 0
    let totalGrossIncomeNgn = 0
    let totalPlatformFees = 0
    let defaultRateUsedCount = 0

    for (const tx of paidTransactions) {
      const amount = Number(tx.amount)
      const storedExchangeRate = tx.exchangeRate ? Number(tx.exchangeRate) : null
      const storedNgnAmount = tx.ngnAmount ? Number(tx.ngnAmount) : null

      const { ngnAmount, usedStoredRate } = await getNgnEquivalent(
        amount,
        storedExchangeRate,
        storedNgnAmount
      )

      if (!usedStoredRate) {
        defaultRateUsedCount++
      }

      const platformFee = round2(amount * PLATFORM_FEE_RATE)

      processedRows.push({
        transactionDate: formatDateForTax(tx.completedAt || new Date()),
        invoiceNumber: tx.invoice?.invoiceNumber || `TX-${tx.id.slice(0, 8)}`,
        clientName: tx.invoice?.clientName || tx.invoice?.clientEmail || 'Unknown Client',
        natureOfService: tx.invoice?.description || 'Freelance Services',
        grossAmountUsdc: round2(amount),
        grossAmountNgn: ngnAmount,
        taxDeducted: platformFee,
      })

      totalGrossIncomeUsdc += amount
      totalGrossIncomeNgn += ngnAmount
      totalPlatformFees += platformFee
    }

    // Round totals
    totalGrossIncomeUsdc = round2(totalGrossIncomeUsdc)
    totalGrossIncomeNgn = round2(totalGrossIncomeNgn)
    totalPlatformFees = round2(totalPlatformFees)

    const summary: TCCSummary = {
      year,
      totalGrossIncomeUsdc,
      totalGrossIncomeNgn,
      totalPlatformFees,
      totalTransactions: processedRows.length,
      generatedAt: new Date().toISOString(),
      defaultExchangeRateUsed: defaultRateUsedCount > 0,
      exchangeRateNote:
        defaultRateUsedCount > 0
          ? `${defaultRateUsedCount} transaction(s) used current exchange rate as historical rate was not available`
          : 'All transactions used historical exchange rates at time of payment',
    }

    // Return JSON format
    if (format === 'json') {
      return NextResponse.json({
        year,
        summary,
        transactions: processedRows.map(row => ({
          transactionDate: row.transactionDate,
          invoiceNumber: row.invoiceNumber,
          clientName: row.clientName,
          natureOfService: row.natureOfService,
          grossAmountUsdc: row.grossAmountUsdc,
          grossAmountNgn: row.grossAmountNgn,
          taxDeducted: row.taxDeducted,
        })),
      })
    }

    // Return CSV format (default)
    const csvLines: string[] = []

    // Add summary section at the top
    csvLines.push('# TCC DATA EXPORT - FEDERAL INLAND REVENUE SERVICE (FIRS) FORMAT')
    csvLines.push(`# Fiscal Year: ${year}`)
    csvLines.push(`# Generated At: ${summary.generatedAt}`)
    csvLines.push(`# Total Gross Income (NGN): ${totalGrossIncomeNgn.toLocaleString('en-NG', { style: 'currency', currency: 'NGN' })}`)
    csvLines.push(`# Total Gross Income (USDC): $${totalGrossIncomeUsdc.toFixed(2)}`)
    csvLines.push(`# Total Platform Fees Paid: $${totalPlatformFees.toFixed(2)}`)
    csvLines.push(`# Total Transactions: ${summary.totalTransactions}`)
    if (summary.defaultExchangeRateUsed) {
      csvLines.push(`# Note: ${summary.exchangeRateNote}`)
    }
    csvLines.push('') // Empty line before data

    // Add CSV headers
    csvLines.push(
      toCsvRow([
        'Transaction Date',
        'Invoice Number',
        'Client Name',
        'Nature of Service',
        'Gross Amount (USDC)',
        'Gross Amount (NGN Equivalent)',
        'Tax Deducted (Platform Fee)',
      ])
    )

    // Add data rows
    for (const row of processedRows) {
      csvLines.push(
        toCsvRow([
          row.transactionDate,
          row.invoiceNumber,
          row.clientName,
          row.natureOfService,
          row.grossAmountUsdc.toFixed(2),
          row.grossAmountNgn.toFixed(2),
          row.taxDeducted.toFixed(2),
        ])
      )
    }

    // Add footer with totals
    csvLines.push('') // Empty line
    csvLines.push(toCsvRow(['', '', '', 'TOTALS', totalGrossIncomeUsdc.toFixed(2), totalGrossIncomeNgn.toFixed(2), totalPlatformFees.toFixed(2)]))

    const csvContent = csvLines.join('\n')

    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="tcc_data_${year}_lancepay.csv"`,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'TCC Data Generator Error:')
    return NextResponse.json(
      { error: 'Failed to generate TCC data. Please try again later.' },
      { status: 500 }
    )
  }
}
