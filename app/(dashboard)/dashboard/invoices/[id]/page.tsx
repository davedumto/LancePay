'use client'

import { usePrivy } from '@privy-io/react-auth'
import { useState, useEffect, use } from 'react'
import { Copy, ExternalLink, FileDown } from 'lucide-react'

export default function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { getAccessToken } = usePrivy()
  const [invoice, setInvoice] = useState<any>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isDownloading, setIsDownloading] = useState(false)

  useEffect(() => {
    async function fetchInvoice() {
      try {
        const token = await getAccessToken()
        const res = await fetch(`/api/routes-d/invoices/${id}`, { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) setInvoice(await res.json())
      } finally {
        setIsLoading(false)
      }
    }
    fetchInvoice()
  }, [id, getAccessToken])

  const copyLink = () => navigator.clipboard.writeText(invoice?.paymentLink)
  
  const downloadPDF = async () => {
    setIsDownloading(true)
    try {
      const res = await fetch(`/api/routes-d/invoices/${id}/pdf`)
      if (!res.ok) throw new Error('Failed to generate PDF')
      
      const blob = await res.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${invoice.invoiceNumber}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(url)
    } catch (error) {
      console.error('PDF download failed:', error)
      alert('Failed to download PDF')
    } finally {
      setIsDownloading(false)
    }
  }

  if (isLoading) return <div className="animate-pulse">Loading...</div>
  if (!invoice) return <div>Invoice not found</div>

  const statusClass = invoice.status === 'paid' ? 'bg-green-100 text-green-800' : invoice.status === 'pending' ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-800'

  return (
    <div className="max-w-2xl mx-auto">
      <div className="bg-white rounded-xl border border-brand-border p-6">
        <div className="flex justify-between items-start mb-6">
          <div>
            <h1 className="text-2xl font-bold text-brand-black">{invoice.invoiceNumber}</h1>
            <p className="text-brand-gray">{invoice.clientEmail}</p>
          </div>
          <span className={`px-3 py-1 rounded-full text-sm font-medium ${statusClass}`}>{invoice.status.toUpperCase()}</span>
        </div>

        <div className="border-t border-brand-border pt-4 mb-4">
          <p className="text-brand-gray mb-2">{invoice.description}</p>
          <p className="text-3xl font-bold text-brand-black">${Number(invoice.amount).toFixed(2)}</p>
        </div>

        <div className="bg-brand-light rounded-lg p-4 mb-4">
          <p className="text-sm text-brand-gray mb-2">Payment Link</p>
          <div className="flex items-center gap-2">
            <input type="text" value={invoice.paymentLink} readOnly className="flex-1 px-3 py-2 bg-white border border-brand-border rounded-lg text-sm" />
            <button onClick={copyLink} className="p-2 bg-brand-black text-white rounded-lg hover:bg-gray-800"><Copy className="w-4 h-4" /></button>
            <a href={invoice.paymentLink} target="_blank" rel="noopener noreferrer" className="p-2 border border-brand-border rounded-lg hover:bg-brand-light"><ExternalLink className="w-4 h-4" /></a>
          </div>
        </div>

        {/* Download PDF Button */}
        <button
          onClick={downloadPDF}
          disabled={isDownloading}
          className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-brand-black text-white rounded-xl hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <FileDown className="w-5 h-5" />
          {isDownloading ? 'Generating PDF...' : 'Download Invoice PDF'}
        </button>
      </div>
    </div>
  )
}

