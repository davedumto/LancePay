'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { usePrivy } from '@privy-io/react-auth'

export function InvoiceForm() {
  const router = useRouter()
  const { getAccessToken } = usePrivy()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ clientEmail: '', clientName: '', description: '', amount: '', currency: 'USD', dueDate: '' })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError('')

    try {
      const token = await getAccessToken()
      const res = await fetch('/api/routes-d/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...form, amount: parseFloat(form.amount) }),
      })

      if (!res.ok) throw new Error((await res.json()).error || 'Failed to create invoice')
      const invoice = await res.json()
      router.push(`/dashboard/invoices/${invoice.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setIsLoading(false)
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }))
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">{error}</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-medium text-brand-black mb-2">Client Email *</label>
          <input type="email" name="clientEmail" value={form.clientEmail} onChange={handleChange} required className="w-full px-4 py-3 rounded-lg border border-brand-border focus:border-brand-black outline-none" placeholder="client@company.com" />
        </div>
        <div>
          <label className="block text-sm font-medium text-brand-black mb-2">Client Name</label>
          <input type="text" name="clientName" value={form.clientName} onChange={handleChange} className="w-full px-4 py-3 rounded-lg border border-brand-border focus:border-brand-black outline-none" placeholder="John Smith" />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-brand-black mb-2">Description *</label>
        <textarea name="description" value={form.description} onChange={handleChange} required rows={3} className="w-full px-4 py-3 rounded-lg border border-brand-border focus:border-brand-black outline-none resize-none" placeholder="Logo design, website development, etc." />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-medium text-brand-black mb-2">Amount *</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input type="number" name="amount" value={form.amount} onChange={handleChange} required min="1" step="0.01" className="w-full px-4 py-3 rounded-lg border border-brand-border focus:border-brand-black outline-none" placeholder="0.00" />
            </div>
            <select
              name="currency"
              value={form.currency}
              onChange={handleChange}
              className="w-24 px-2 py-3 rounded-lg border border-brand-border focus:border-brand-black outline-none bg-white"
            >
              <option value="USD">USD</option>
              <option value="USDC">USDC</option>
              <option value="XLM">XLM</option>
              <option value="EUR">EUR</option>
              {/* In a real app, populate this from user's trustlines or supported assets */}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-brand-black mb-2">Due Date</label>
          <input type="date" name="dueDate" value={form.dueDate} onChange={handleChange} className="w-full px-4 py-3 rounded-lg border border-brand-border focus:border-brand-black outline-none" />
        </div>
      </div>

      <div className="flex gap-4">
        <button type="submit" disabled={isLoading} className="flex-1 py-3 px-4 bg-brand-black text-white rounded-lg font-medium hover:bg-gray-800 transition-colors disabled:opacity-50">
          {isLoading ? 'Creating...' : 'Create Invoice'}
        </button>
        <button type="button" onClick={() => router.back()} className="px-6 py-3 border border-brand-border rounded-lg font-medium hover:bg-brand-light transition-colors">Cancel</button>
      </div>
    </form>
  )
}
