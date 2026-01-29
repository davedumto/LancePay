'use client'

import { useState } from 'react'

interface ReceiptUploadFormProps {
  invoiceNumber: string
  defaultClientName?: string
}

export function ReceiptUploadForm({
  invoiceNumber,
  defaultClientName,
}: ReceiptUploadFormProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const [formData, setFormData] = useState({
    clientName: defaultClientName || '',
    amountPaid: '',
    currency: 'NGN',
    notes: '',
  })

  const [file, setFile] = useState<File | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      if (!file) throw new Error('Please select a receipt file')

      const form = new FormData()
      form.append('invoiceNumber', invoiceNumber)
      form.append('clientName', formData.clientName)
      form.append('amountPaid', formData.amountPaid)
      form.append('currency', formData.currency)
      form.append('notes', formData.notes)
      form.append('receipt', file)

      const res = await fetch(
        '/api/routes-d/local/offline-verification/submit',
        {
          method: 'POST',
          body: form,
        }
      )

      const data = await res.json()

      if (!res.ok) throw new Error(data.error || 'Failed to submit')

      setSuccess(true)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div className="p-6 bg-green-50 border border-green-200 rounded-lg">
        <h3 className="text-lg font-semibold text-green-900">
          Payment Proof Submitted!
        </h3>
        <p className="text-green-700 mt-2">
          Your payment proof has been submitted. The freelancer will verify it
          shortly.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">Your Name</label>
        <input
          type="text"
          required
          value={formData.clientName}
          onChange={(e) =>
            setFormData({ ...formData, clientName: e.target.value })
          }
          className="w-full px-3 py-2 border rounded-lg"
          placeholder="Enter your name"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          Amount Paid (NGN)
        </label>
        <input
          type="number"
          required
          step="0.01"
          value={formData.amountPaid}
          onChange={(e) =>
            setFormData({ ...formData, amountPaid: e.target.value })
          }
          className="w-full px-3 py-2 border rounded-lg"
          placeholder="0.00"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          Upload Receipt
        </label>
        <input
          type="file"
          required
          accept=".jpg,.jpeg,.png,.webp,.heic,.pdf"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          className="w-full px-3 py-2 border rounded-lg"
        />
        <p className="text-xs text-gray-500 mt-1">
          JPG, PNG, WEBP, HEIC, PDF (max 10MB)
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          Notes (Optional)
        </label>
        <textarea
          value={formData.notes}
          onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
          className="w-full px-3 py-2 border rounded-lg"
          rows={3}
          placeholder="Any additional information..."
        />
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? 'Submitting...' : 'Submit Payment Proof'}
      </button>
    </form>
  )
}
