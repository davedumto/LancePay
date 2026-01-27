'use client'

import Link from 'next/link'
import { Plus } from 'lucide-react'
import { usePrivy } from '@privy-io/react-auth'
import { useState, useEffect } from 'react'
import { InvoiceCard } from '@/components/invoices/invoice-card'

export default function InvoicesPage() {
  const { getAccessToken } = usePrivy()
  const [invoices, setInvoices] = useState([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    async function fetchInvoices() {
      try {
        const token = await getAccessToken()
        const res = await fetch('/api/routes-d/invoices', { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) setInvoices((await res.json()).invoices)
      } finally {
        setIsLoading(false)
      }
    }
    fetchInvoices()
  }, [getAccessToken])

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-brand-black">Invoices</h1>
          <p className="text-brand-gray">Manage your invoices and payment links</p>
        </div>
        <Link href="/dashboard/invoices/new" className="flex items-center gap-2 px-4 py-2.5 bg-brand-black text-white rounded-lg font-medium hover:bg-gray-800 transition-colors">
          <Plus className="w-5 h-5" />
          New Invoice
        </Link>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2, 3].map((i) => <div key={i} className="bg-white rounded-xl border border-brand-border p-4 animate-pulse"><div className="h-20 bg-gray-200 rounded" /></div>)}
        </div>
      ) : invoices.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-brand-border">
          <p className="text-brand-gray mb-2">No invoices yet</p>
          <Link href="/dashboard/invoices/new" className="text-brand-black underline">Create your first invoice</Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {invoices.map((invoice: { id: string }) => <InvoiceCard key={invoice.id} invoice={invoice as any} />)}
        </div>
      )}
    </div>
  )
}
