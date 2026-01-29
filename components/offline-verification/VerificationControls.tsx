'use client'

import { useState } from 'react'

interface VerificationControlsProps {
  paymentId: string
  onSuccess?: () => void
  authToken: string
}

export function VerificationControls({
  paymentId,
  onSuccess,
  authToken,
}: VerificationControlsProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState('')

  const handleVerify = async (action: 'confirm' | 'reject') => {
    setError(null)
    setLoading(true)

    try {
      const res = await fetch(
        '/api/routes-d/local/offline-verification/verify',
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            paymentId,
            action,
            notes: notes || undefined,
          }),
        }
      )

      const data = await res.json()

      if (!res.ok) throw new Error(data.error || 'Verification failed')

      onSuccess?.()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium mb-1">
          Verification Notes (Optional)
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="w-full px-3 py-2 border rounded-lg"
          rows={3}
          placeholder="Add notes about this verification..."
        />
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={() => handleVerify('confirm')}
          disabled={loading}
          className="flex-1 bg-green-600 text-white py-2 px-4 rounded-lg hover:bg-green-700 disabled:opacity-50"
        >
          {loading ? 'Processing...' : 'Confirm Payment'}
        </button>
        <button
          onClick={() => handleVerify('reject')}
          disabled={loading}
          className="flex-1 bg-red-600 text-white py-2 px-4 rounded-lg hover:bg-red-700 disabled:opacity-50"
        >
          Reject
        </button>
      </div>
    </div>
  )
}
