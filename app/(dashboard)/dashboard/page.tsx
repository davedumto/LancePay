"use client";

import { useState, useEffect } from "react";
import { BalanceCard } from "@/components/dashboard/balance-card";
import { QuickActions } from "@/components/dashboard/quick-actions";
import { TransactionList } from "@/components/dashboard/transaction-list";

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

export default function DashboardPage() {
  const [balance, setBalance] = useState(null);
  const [profile, setProfile] = useState<{ name?: string } | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isMockMode, setIsMockMode] = useState(false);

  useEffect(() => {
    async function fetchData() {
      try {
        // Check if using mock authentication
        const mockAuth = localStorage.getItem("mock-auth");
        if (mockAuth) {
          setIsMockMode(true);
          setProfile({ name: "Demo User" });
          setBalance({ usdc: "100.00", usd: "100.00" });
          setIsLoading(false);
          return;
        }

        // Try to get Privy token
        let token = null;
        try {
          const { usePrivy } = await import("@privy-io/react-auth");
          const { getAccessToken } = usePrivy();
          token = await getAccessToken();
        } catch (error) {
          console.error("Privy not available:", error);
          setIsLoading(false);
          return;
        }

        if (!token) {
          setIsLoading(false);
          return;
        }

        const headers = { Authorization: `Bearer ${token}` };

        // Sync wallet first (ensures wallet is stored in DB)
        await fetch("/api/user/sync-wallet", { method: "POST", headers });

        // Then fetch balance, profile, and transactions
        const [balanceRes, profileRes, transactionsRes] = await Promise.all([
          fetch("/api/user/balance", { headers }),
          fetch("/api/user/profile", { headers }),
          fetch("/api/transactions", { headers }),
        ]);
        if (balanceRes.ok) setBalance(await balanceRes.json());
        if (profileRes.ok) setProfile(await profileRes.json());
        if (transactionsRes.ok) {
          const data = await transactionsRes.json();
          setTransactions(data.transactions || []);
        }
      } catch (error) {
        console.error("Error fetching data:", error);
      } finally {
        setIsLoading(false);
      }
    }
    fetchData();
  }, []);

  const greeting = profile?.name
    ? `Hey, ${profile.name}! 👋`
    : "Welcome back! 👋";

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {isMockMode && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
          <strong>Demo Mode:</strong> You're viewing mock data. API calls are
          disabled.
        </div>
      )}

      <div>
        <p className="text-sm text-brand-gray mb-1">Dashboard</p>
        <h1 className="text-3xl font-bold text-brand-black">{greeting}</h1>
      </div>

      <BalanceCard balance={balance} isLoading={isLoading} />
      <QuickActions />

      <div className="bg-white rounded-2xl border border-brand-border p-6">
        <h3 className="text-lg font-semibold text-brand-black mb-4">
          Recent Activity
        </h3>
        <TransactionList transactions={transactions} isLoading={isLoading} />
      </div>
    </div>
  );
}
