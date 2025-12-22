'use client'

import { formatDistanceToNow } from 'date-fns'

interface Transaction {
  id: string
  type: string
  status: string
  amount: number
  currency: string
  createdAt: string
  invoice?: { invoiceNumber: string; clientName?: string | null; description: string } | null
  bankAccount?: { bankName: string; accountNumber: string } | null
}

export function TransactionList({ transactions, isLoading }: { transactions: Transaction[]; isLoading?: boolean }) {
  if (isLoading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="animate-pulse flex items-center gap-4 p-4 bg-gray-50 rounded-xl">
            <div className="w-10 h-10 bg-gray-200 rounded-full" />
            <div className="flex-1 space-y-2">
              <div className="h-4 bg-gray-200 rounded w-1/3" />
              <div className="h-3 bg-gray-200 rounded w-1/4" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (!transactions.length) {
    return <p className="text-brand-gray text-center py-8">No transactions yet. Create your first invoice!</p>
  }

  return (
    <div className="space-y-3">
      {transactions.map((tx) => {
        const isPayment = tx.type === 'payment'
        const title = isPayment 
          ? `Payment from ${tx.invoice?.clientName || 'Client'}`
          : `Withdrawal to ${tx.bankAccount?.bankName || 'Bank'}`
        
        return (
          <div key={tx.id} className="flex items-center gap-4 p-4 bg-gray-50 hover:bg-gray-100 rounded-xl">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isPayment ? 'bg-green-100' : 'bg-blue-100'}`}>
              <span className={isPayment ? 'text-green-600' : 'text-blue-600'}>{isPayment ? '↓' : '↑'}</span>
            </div>
            <div className="flex-1">
              <p className="font-medium text-brand-black">{title}</p>
              <p className="text-sm text-brand-gray">{tx.invoice?.invoiceNumber || 'Transfer'}</p>
            </div>
            <div className="text-right">
              <p className={`font-semibold ${isPayment ? 'text-green-600' : 'text-brand-black'}`}>
                {isPayment ? '+' : '-'}${tx.amount.toFixed(2)}
              </p>
              <span className="text-xs text-brand-gray">
                {formatDistanceToNow(new Date(tx.createdAt), { addSuffix: true })}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
