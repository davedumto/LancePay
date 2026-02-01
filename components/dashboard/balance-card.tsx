interface BalanceCardProps {
  totalValue: number
  currency: string
  isLoading: boolean
}

export function BalanceCard({ totalValue, currency, isLoading }: BalanceCardProps) {
  if (isLoading) {
    return (
      <div className="bg-white rounded-2xl border border-brand-border p-6 animate-pulse">
        <div className="h-4 bg-gray-200 rounded w-24 mb-4" />
        <div className="h-10 bg-gray-200 rounded w-32 mb-2" />
        <div className="h-4 bg-gray-200 rounded w-40" />
      </div>
    )
  }

  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency,
  });

  return (
    <div className="bg-white rounded-2xl border border-brand-border p-6">
      <p className="text-sm text-brand-gray font-medium mb-1">Total Portfolio Value</p>
      <h2 className="text-4xl font-bold text-brand-black mb-2">
        {formatter.format(totalValue)}
      </h2>
      <p className="text-sm text-brand-gray">
        Across all assets
      </p>
    </div>
  )
}
