interface BalanceCardProps {
  balance: any | null;
  isLoading: boolean;
}

export function BalanceCard({ balance, isLoading }: BalanceCardProps) {
  if (isLoading) {
    return (
      <div className="bg-white rounded-2xl border border-brand-border p-6 animate-pulse">
        <div className="h-4 bg-gray-200 rounded w-24 mb-4" />
        <div className="h-10 bg-gray-200 rounded w-32 mb-2" />
        <div className="h-4 bg-gray-200 rounded w-40" />
      </div>
    );
  }

  // Handle different balance formats
  let displayBalance = "$0.00";
  let localEquivalent = "₦0";
  let rate = 0;

  if (balance) {
    // Format 1: { available: { display: string }, localEquivalent: { display: string, rate: number } }
    if (balance.available?.display) {
      displayBalance = balance.available.display;
      localEquivalent = balance.localEquivalent?.display || "₦0";
      rate = balance.localEquivalent?.rate || 0;
    }
    // Format 2: { usdc: string, usd: string }
    else if (balance.usdc || balance.usd) {
      const amount = parseFloat(balance.usdc || balance.usd || "0");
      displayBalance = `$${amount.toFixed(2)}`;
      rate = 1600; // Default rate
      localEquivalent = `₦${(amount * rate).toLocaleString()}`;
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-brand-border p-6">
      <p className="text-sm text-brand-gray font-medium mb-1">
        Available Balance
      </p>
      <h2 className="text-4xl font-bold text-brand-black mb-2">
        {displayBalance}
      </h2>
      <p className="text-sm text-brand-gray">
        ≈ {localEquivalent}
        {rate > 0 && (
          <span className="text-xs ml-1">@ ₦{rate.toLocaleString()}/$1</span>
        )}
      </p>
    </div>
  );
}
