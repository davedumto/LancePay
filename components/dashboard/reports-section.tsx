
'use client'

import { useState } from 'react'
import { usePrivy } from '@privy-io/react-auth'
import { Download, FileText } from 'lucide-react'
import { toast } from 'sonner'
import { startOfYear, subDays, endOfDay, format } from 'date-fns'
import { cn } from '@/lib/utils'

type DateRangeType = 'last_30_days' | 'current_year' | 'all_time'

export function ReportsSection() {
    const { getAccessToken } = usePrivy()
    const [isDownloading, setIsDownloading] = useState(false)
    const [rangeType, setRangeType] = useState<DateRangeType>('last_30_days')

    const handleDownload = async (formatType: 'csv' | 'pdf') => {
        try {
            setIsDownloading(true)
            const token = await getAccessToken()
            if (!token) {
                toast.error('You must be logged in to download reports')
                return
            }

            const queryParams = new URLSearchParams()
            queryParams.set('format', formatType)

            const now = new Date()
            let start: Date | undefined
            let end: Date | undefined = endOfDay(now)

            if (rangeType === 'last_30_days') {
                start = subDays(now, 30)
            } else if (rangeType === 'current_year') {
                start = startOfYear(now)
            }

            if (start) queryParams.set('startDate', start.toISOString())
            if (end) queryParams.set('endDate', end.toISOString())

            toast.info(`Generating ${formatType.toUpperCase()} report...`)

            const response = await fetch(`/api/transactions/export?${queryParams.toString()}`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            })

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}))
                throw new Error(errorData.error || 'Failed to generate report')
            }

            const blob = await response.blob()
            const url = window.URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            // Content-Disposition header should provide filename, but fallback just in case
            const filename = `lancepay-${formatType}-${format(new Date(), 'yyyy-MM-dd')}.${formatType}`
            a.download = filename
            document.body.appendChild(a)
            a.click()
            window.URL.revokeObjectURL(url)
            document.body.removeChild(a)

            toast.success('Report downloaded successfully')

        } catch (error: any) {
            console.error('Download error:', error)
            toast.error(error.message || 'Failed to download report')
        } finally {
            setIsDownloading(false)
        }
    }

    return (
        <div className="bg-white rounded-2xl border border-brand-border p-6 mb-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                <div>
                    <h3 className="text-lg font-semibold text-brand-black">Financial Reports</h3>
                    <p className="text-sm text-brand-gray">Download transaction history for tax and accounting.</p>
                </div>

                {/* Date Range Selector */}
                <div className="flex items-center gap-2 bg-gray-50 p-1 rounded-lg border border-gray-200">
                    <button
                        onClick={() => setRangeType('last_30_days')}
                        className={cn(
                            "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                            rangeType === 'last_30_days' ? "bg-white shadow-sm text-brand-black" : "text-gray-500 hover:text-gray-900"
                        )}
                    >
                        Last 30 Days
                    </button>
                    <button
                        onClick={() => setRangeType('current_year')}
                        className={cn(
                            "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                            rangeType === 'current_year' ? "bg-white shadow-sm text-brand-black" : "text-gray-500 hover:text-gray-900"
                        )}
                    >
                        This Year
                    </button>
                    <button
                        onClick={() => setRangeType('all_time')}
                        className={cn(
                            "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                            rangeType === 'all_time' ? "bg-white shadow-sm text-brand-black" : "text-gray-500 hover:text-gray-900"
                        )}
                    >
                        All Time
                    </button>
                </div>
            </div>

            <div className="flex gap-3">
                <button
                    onClick={() => handleDownload('csv')}
                    disabled={isDownloading}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-brand-black text-sm font-medium rounded-xl transition-colors disabled:opacity-50"
                >
                    <FileText size={16} />
                    <span>Export CSV</span>
                </button>

                <button
                    onClick={() => handleDownload('pdf')}
                    disabled={isDownloading}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-brand-black hover:bg-gray-800 text-white text-sm font-medium rounded-xl transition-colors disabled:opacity-50"
                >
                    <Download size={16} />
                    <span>Export PDF</span>
                </button>
            </div>
        </div>
    )
}
