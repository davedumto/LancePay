'use client'

import { useState } from 'react'

interface ManualPaymentCardProps {
  payment: {
    id: string
    invoiceNumber: string
    clientName: string
    amountPaid: number
    currency: string
    receiptUrl: string
    status: string
    notes: string | null
    createdAt: string
    invoice: {
      expectedAmount: number
      expectedCurrency: string
    }
  }
  onVerify?: (
    paymentId: string,
    action: 'confirm' | 'reject',
    notes?: string
  ) => void
}

export function ManualPaymentCard({
  payment,
  onVerify,
}: ManualPaymentCardProps) {
  const [showReceipt, setShowReceipt] = useState(false)
  const [verifyNotes, setVerifyNotes] = useState('')

  const statusColors = {
    pending: 'bg-yellow-100 text-yellow-800',
    verified: 'bg-green-100 text-green-800',
    rejected: 'bg-red-100 text-red-800',
  }

  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex justify-between items-start">
        <div>
          <h3 className="font-semibold">Invoice: {payment.invoiceNumber}</h3>
          <p className="text-sm text-gray-600">From: {payment.clientName}</p>
        </div>
        <span
          className={`px-2 py-1 rounded text-xs font-medium ${
            statusColors[payment.status as keyof typeof statusColors]
          }`}
        >
          {payment.status}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <p className="text-gray-600">Paid Amount:</p>
          <p className="font-semibold">
            {payment.currency} {payment.amountPaid.toLocaleString()}
          </p>
        </div>
        <div>
          <p className="text-gray-600">Expected:</p>
          <p className="font-semibold">
            {payment.invoice.expectedCurrency}{' '}
            {payment.invoice.expectedAmount}
          </p>
        </div>
      </div>

      {payment.notes && (
        <div className="text-sm bg-gray-50 p-2 rounded">
          <p className="text-gray-600">Notes:</p>
          <p>{payment.notes}</p>
        </div>
      )}

      <button
        onClick={() => setShowReceipt(!showReceipt)}
        className="text-blue-600 text-sm hover:underline"
      >
        {showReceipt ? 'Hide' : 'View'} Receipt
      </button>

      {showReceipt && (
        <div className="border-t pt-3">
          <img
            src={payment.receiptUrl}
            alt="Payment receipt"
            className="max-w-full rounded"
          />
        </div>
      )}

      {payment.status === 'pending' && onVerify && (
        <div className="border-t pt-3 space-y-2">
          <textarea
            placeholder="Add verification notes (optional)"
            value={verifyNotes}
            onChange={(e) => setVerifyNotes(e.target.value)}
            className="w-full px-3 py-2 border rounded text-sm"
            rows={2}
          />
          <div className="flex gap-2">
            <button
              onClick={() => onVerify(payment.id, 'confirm', verifyNotes)}
              className="flex-1 bg-green-600 text-white py-2 rounded hover:bg-green-700"
            >
              Confirm Payment
            </button>
            <button
              onClick={() => onVerify(payment.id, 'reject', verifyNotes)}
              className="flex-1 bg-red-600 text-white py-2 rounded hover:bg-red-700"
            >
              Reject
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
