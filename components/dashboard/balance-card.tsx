'use client'

import { Info } from 'lucide-react'
import { useState } from 'react'

interface BalanceCardProps {
  balance: {
    available: { display: string }
    localEquivalent: { display: string; rate: number }
    xlm?: number
  } | null
  isLoading: boolean
  xlmBalance?: number
}

export function BalanceCard({ balance, isLoading, xlmBalance }: BalanceCardProps) {
  const [showTooltip, setShowTooltip] = useState(false)
  const displayXlm = xlmBalance ?? balance?.xlm ?? 0

  if (isLoading) {
    return (
      <div className="bg-white rounded-2xl border border-brand-border p-6 animate-pulse">
        <div className="h-4 bg-gray-200 rounded w-24 mb-4" />
        <div className="h-10 bg-gray-200 rounded w-32 mb-2" />
        <div className="h-4 bg-gray-200 rounded w-40" />
      </div>
    )
  }

  return (
    <div className="bg-white rounded-2xl border border-brand-border p-6">
      <p className="text-sm text-brand-gray font-medium mb-1">Available Balance</p>
      <h2 className="text-4xl font-bold text-brand-black mb-2">
        {balance?.available.display || '$0.00'}
      </h2>
      <p className="text-sm text-brand-gray mb-3">
        ≈ {balance?.localEquivalent.display || '₦0'}
        <span className="text-xs ml-1">@ ₦{balance?.localEquivalent.rate?.toLocaleString() || '0'}/$1</span>
      </p>

      {/* XLM Reserve Display */}
      <div className="flex items-center gap-1.5 relative">
        <p className="text-xs text-gray-500">
          XLM Reserve: {displayXlm.toFixed(2)} XLM
        </p>
        <div className="relative">
          <button
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
            onClick={() => setShowTooltip(!showTooltip)}
            className="text-gray-500 hover:text-gray-700 transition-colors focus:outline-none"
            aria-label="XLM reserve information"
          >
            <Info className="w-3.5 h-3.5" />
          </button>

          {/* Tooltip */}
          {showTooltip && (
            <div className="absolute left-0 bottom-full mb-2 w-64 sm:w-72 p-3 bg-gray-900 text-white text-xs rounded-lg shadow-lg z-10">
              <p>
                XLM reserves keep your Stellar account active. This amount is locked but recoverable if you close your account.
              </p>
              <div className="absolute left-4 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
