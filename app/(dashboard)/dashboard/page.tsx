"use client";

import { usePrivy } from '@privy-io/react-auth'
import { useState, useEffect, useCallback } from 'react'
import { BalanceCard } from '@/components/dashboard/balance-card'
import { AssetList } from '@/components/dashboard/asset-list'
import { QuickActions } from '@/components/dashboard/quick-actions'
import { TransactionList } from '@/components/dashboard/transaction-list'
import { AssetMetadata } from '@/lib/assets'

interface Transaction {
  id: string;
  type: string;
  status: string;
  amount: number;
  currency: string;
  createdAt: string;
  invoice?: {
    invoiceNumber: string;
    clientName?: string | null;
    description: string;
  } | null;
  bankAccount?: { bankName: string; accountNumber: string } | null;
}

interface Asset {
  code: string;
  issuer?: string;
  balance: string;
  value: number;
  metadata: AssetMetadata;
}

interface Portfolio {
  available?: { display: string }
  localEquivalent?: { display: string; rate: number }
  xlm?: number | string
  usdc?: string | number
  usd?: string | number
  totalValue?: number
  currency?: string
  assets?: Asset[]
}

export default function DashboardPage() {
  const { getAccessToken } = usePrivy()
  const [balance, setBalance] = useState<Portfolio | null>(null)
  const [profile, setProfile] = useState<{ name?: string } | null>(null)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const fetchData = useCallback(async () => {
    try {
      const token = await getAccessToken()
      const headers = { Authorization: `Bearer ${token}` }

      await fetch('/api/user/sync-wallet', { method: 'POST', headers })

      const [balanceRes, profileRes, transactionsRes] = await Promise.all([
        fetch('/api/user/balance', { headers }),
        fetch('/api/user/profile', { headers }),
        fetch('/api/transactions', { headers }),
      ])

      if (balanceRes.ok) setBalance(await balanceRes.json())
      if (profileRes.ok) setProfile(await profileRes.json())
      if (transactionsRes.ok) {
        const data = await transactionsRes.json()
        setTransactions(data.transactions || [])
      }
    } finally {
      setIsLoading(false)
    }
  }, [getAccessToken])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const greeting = profile?.name
    ? `Hey, ${profile.name}!`
    : 'Welcome back!'

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <p className="text-sm text-brand-gray mb-1">Dashboard</p>
        <h1 className="text-3xl font-bold text-brand-black">{greeting}</h1>
      </div>

      <BalanceCard balance={balance} isLoading={isLoading} />

      <QuickActions />

      <AssetList
        assets={balance?.assets || []}
        currency={balance?.currency || 'USD'}
      />

      <div className="bg-white rounded-2xl border border-brand-border p-6 mt-6">
        <h3 className="text-lg font-semibold text-brand-black mb-4">Recent Activity</h3>
        <TransactionList transactions={transactions} isLoading={isLoading} />
      </div>
    </div>
  )
}
