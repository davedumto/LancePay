'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { usePrivy } from '@privy-io/react-auth'
import { Wand2, Loader2 } from 'lucide-react'
import { logger } from '@/lib/logger'

export function InvoiceForm() {
  const router = useRouter()
  const { getAccessToken } = usePrivy()
  const [isLoading, setIsLoading] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ clientEmail: '', clientName: '', description: '', amount: '', currency: 'USD', dueDate: '' })
  const [isRecurring, setIsRecurring] = useState(false)
  const [interval, setIntervalValue] = useState('1')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError('')

    try {
      const token = await getAccessToken()
      const endpoint = isRecurring ? '/api/routes-d/subscriptions' : '/api/routes-d/invoices'
      const payload = isRecurring
        ? { ...form, amount: parseFloat(form.amount), interval: parseInt(interval), frequency: 'monthly' }
        : { ...form, amount: parseFloat(form.amount) }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      })

      if (!res.ok) throw new Error((await res.json()).error || 'Failed to create request')
      const result = await res.json()

      if (isRecurring) {
        router.push(`/dashboard/subscriptions`)
      } else {
        router.push(`/dashboard/invoices/${result.id}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setIsLoading(false)
    }
  }

  const handleMagicWrite = async () => {
    if (!form.description.trim()) {
      setError('Please enter some keywords first')
      return
    }

    setIsGenerating(true)
    setError('')

    try {
      const res = await fetch('/api/ai/generate-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: form.description }),
      })

      if (!res.ok) throw new Error('Failed to generate description')
      const data = await res.json()
      setForm(prev => ({ ...prev, description: data.description }))
    } catch (err) {
      logger.error({ err }, 'Magic Write failed')
      setError('Failed to generate professional description')
    } finally {
      setIsGenerating(false)
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
        <div className="flex justify-between items-center mb-2">
          <label className="block text-sm font-medium text-brand-black">Description *</label>
          <button
            type="button"
            onClick={handleMagicWrite}
            disabled={isGenerating || !form.description.trim()}
            className="flex items-center gap-1.5 text-xs font-semibold text-brand-black bg-brand-light px-3 py-1.5 rounded-full hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            {isGenerating ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Wand2 className="w-3.5 h-3.5" />
            )}
            Magic Write
          </button>
        </div>
        <textarea name="description" value={form.description} onChange={handleChange} required rows={3} className="w-full px-4 py-3 rounded-lg border border-brand-border focus:border-brand-black outline-none resize-none" placeholder="Logo design, website development, etc." />
        <p className="mt-1 text-xs text-gray-500 italic">Enter keywords and click 'Magic Write' for a professional touch.</p>
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

      <div className="pt-4 border-t border-brand-border">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={isRecurring}
            onChange={(e) => setIsRecurring(e.target.checked)}
            className="w-4 h-4 rounded border-brand-border text-brand-black focus:ring-brand-black"
          />
          <span className="text-sm font-medium text-brand-black">Recurring billing (automatic monthly generation)</span>
        </label>

        {isRecurring && (
          <div className="mt-4 p-4 bg-gray-50 rounded-lg flex items-center gap-3">
            <span className="text-sm text-brand-gray">Repeat every</span>
            <input
              type="number"
              value={interval}
              onChange={(e) => setIntervalValue(e.target.value)}
              min="1"
              max="12"
              className="w-16 px-2 py-2 rounded-lg border border-brand-border outline-none focus:border-brand-black bg-white"
            />
            <span className="text-sm text-brand-gray">month(s)</span>
          </div>
        )}
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
