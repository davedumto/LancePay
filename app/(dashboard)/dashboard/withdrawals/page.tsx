"use client";

import { useState, useEffect } from "react";
import { ArrowUpRight, Plus, Building2, Wallet } from "lucide-react";
import { WithdrawModal } from "@/components/withdraw-modal";

export default function WithdrawalsPage() {
  const [rate, setRate] = useState(1600);
  const [bankAccounts, setBankAccounts] = useState<any[]>([]);
  const [banks, setBanks] = useState<Record<string, string>>({});
  const [withdrawals, setWithdrawals] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAddBank, setShowAddBank] = useState(false);
  const [newBank, setNewBank] = useState({ bankCode: "", accountNumber: "" });
  const [amount, setAmount] = useState("");
  const [selectedBank, setSelectedBank] = useState("");
  const [showSep24Modal, setShowSep24Modal] = useState(false);
  const [balance, setBalance] = useState<any>(null);
  const [user, setUser] = useState<any>(null);
  const [isMockMode, setIsMockMode] = useState(false);

  // Try to get Privy hooks (will fail gracefully if not available)
  let privyHooks = { getAccessToken: async () => null, user: null };
  try {
    const { usePrivy } = require("@privy-io/react-auth");
    privyHooks = usePrivy();
  } catch (error) {
    // Privy not available
  }

  useEffect(() => {
    async function load() {
      // Check for mock authentication
      const mockAuth = localStorage.getItem("mock-auth");
      if (mockAuth) {
        setIsMockMode(true);
        const mockUser = JSON.parse(mockAuth);
        setUser(mockUser);
        setBalance({ usdc: "100.00", usd: "100.00" });
        setIsLoading(false);
        return;
      }

      // Try to get real token
      const token = await privyHooks.getAccessToken();
      if (!token) {
        setIsLoading(false);
        return;
      }

      setUser(privyHooks.user);

      const [rateRes, banksRes, withdrawRes, balanceRes] = await Promise.all([
        fetch("/api/exchange-rate"),
        fetch("/api/bank-accounts", {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch("/api/withdrawals", {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch("/api/user/balance", {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);
      if (rateRes.ok) setRate((await rateRes.json()).rate);
      if (banksRes.ok) {
        const d = await banksRes.json();
        setBankAccounts(d.bankAccounts);
        setBanks(d.banks || {});
        if (d.bankAccounts[0]) setSelectedBank(d.bankAccounts[0].id);
      }
      if (withdrawRes.ok)
        setWithdrawals((await withdrawRes.json()).withdrawals);
      if (balanceRes.ok) setBalance(await balanceRes.json());
      setIsLoading(false);
    }
    load();
  }, []);

  const addBankAccount = async () => {
    if (isMockMode) return; // Disabled in mock mode
    const token = await privyHooks.getAccessToken();
    if (!token) return;
    const res = await fetch("/api/bank-accounts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(newBank),
    });
    if (res.ok) {
      const bank = await res.json();
      setBankAccounts([bank, ...bankAccounts]);
      setShowAddBank(false);
      setNewBank({ bankCode: "", accountNumber: "" });
      setSelectedBank(bank.id);
    }
  };

  const withdraw = async () => {
    if (!amount || !selectedBank) return;
    if (isMockMode) return; // Disabled in mock mode
    const token = await privyHooks.getAccessToken();
    if (!token) return;
    const res = await fetch("/api/withdrawals", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        amount: parseFloat(amount),
        bankAccountId: selectedBank,
      }),
    });
    if (res.ok) {
      const w = await res.json();
      setWithdrawals([w, ...withdrawals]);
      setAmount("");
    }
  };

  if (isLoading) return <div className="animate-pulse">Loading...</div>;

  const walletAddress = user?.wallet?.address || "";
  const usdcBalance = balance?.usdc || "100.00";

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {isMockMode && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
          <strong>Demo Mode:</strong> SEP-24 UI is visible but API calls are
          disabled.
        </div>
      )}
      <h1 className="text-3xl font-bold text-brand-black">Withdrawals</h1>

      {/* Withdrawal Method Selection */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <button
          onClick={() => setShowSep24Modal(true)}
          className="bg-gradient-to-br from-blue-50 to-indigo-50 border-2 border-blue-200 rounded-xl p-6 hover:border-blue-400 transition-all text-left group"
        >
          <div className="flex items-start justify-between mb-3">
            <div className="p-3 bg-blue-100 rounded-lg group-hover:bg-blue-200 transition-colors">
              <Wallet className="w-6 h-6 text-blue-600" />
            </div>
            <span className="text-xs font-medium text-blue-600 bg-blue-100 px-2 py-1 rounded-full">
              SEP-24
            </span>
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">
            Stellar Anchors
          </h3>
          <p className="text-sm text-gray-600 mb-3">
            Withdraw via MoneyGram or Yellow Card using Stellar&apos;s SEP-24
            protocol
          </p>
          <p className="text-xs text-gray-500">
            ✓ Cash pickup or bank transfer
          </p>
        </button>

        <div className="bg-white border-2 border-brand-border rounded-xl p-6 text-left">
          <div className="flex items-start justify-between mb-3">
            <div className="p-3 bg-gray-100 rounded-lg">
              <Building2 className="w-6 h-6 text-gray-600" />
            </div>
            <span className="text-xs font-medium text-gray-600 bg-gray-100 px-2 py-1 rounded-full">
              Legacy
            </span>
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">
            Direct Bank Transfer
          </h3>
          <p className="text-sm text-gray-600 mb-3">
            Traditional withdrawal to your Nigerian bank account
          </p>
          <p className="text-xs text-gray-500">✓ Direct to bank account</p>
        </div>
      </div>

      {/* Exchange Rate Card */}
      <div className="bg-white rounded-xl border border-brand-border p-6">
        <p className="text-sm text-brand-gray mb-1">Current Rate</p>
        <p className="text-2xl font-bold text-brand-black">
          ₦{rate.toLocaleString()} / $1
        </p>
      </div>

      {/* Withdraw Card */}
      <div className="bg-white rounded-xl border border-brand-border p-6 space-y-4">
        <h2 className="text-lg font-semibold">Withdraw to Bank</h2>

        {bankAccounts.length === 0 ? (
          <p className="text-brand-gray">Add a bank account to withdraw</p>
        ) : (
          <>
            <div>
              <label className="block text-sm font-medium mb-2">
                Bank Account
              </label>
              <select
                value={selectedBank}
                onChange={(e) => setSelectedBank(e.target.value)}
                className="w-full px-4 py-3 border border-brand-border rounded-lg"
              >
                {bankAccounts.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.bankName} - ****{b.accountNumber.slice(-4)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">
                Amount (USD)
              </label>
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full px-4 py-3 border border-brand-border rounded-lg"
              />
              {amount && (
                <p className="text-sm text-brand-gray mt-1">
                  ≈ ₦{(parseFloat(amount || "0") * rate).toLocaleString()}
                </p>
              )}
            </div>
            <button
              onClick={withdraw}
              disabled={!amount}
              className="w-full py-3 bg-brand-black text-white rounded-lg font-medium hover:bg-gray-800 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <ArrowUpRight className="w-5 h-5" /> Withdraw
            </button>
          </>
        )}

        <button
          onClick={() => setShowAddBank(!showAddBank)}
          className="w-full py-3 border border-brand-border rounded-lg font-medium hover:bg-brand-light flex items-center justify-center gap-2"
        >
          <Plus className="w-5 h-5" /> Add Bank Account
        </button>

        {showAddBank && (
          <div className="space-y-3 p-4 bg-brand-light rounded-lg">
            <select
              value={newBank.bankCode}
              onChange={(e) =>
                setNewBank({ ...newBank, bankCode: e.target.value })
              }
              className="w-full px-4 py-3 border border-brand-border rounded-lg bg-white"
            >
              <option value="">Select Bank</option>
              {Object.entries(banks).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Account Number (10 digits)"
              maxLength={10}
              value={newBank.accountNumber}
              onChange={(e) =>
                setNewBank({ ...newBank, accountNumber: e.target.value })
              }
              className="w-full px-4 py-3 border border-brand-border rounded-lg"
            />
            <button
              onClick={addBankAccount}
              disabled={
                !newBank.bankCode || newBank.accountNumber.length !== 10
              }
              className="w-full py-3 bg-brand-black text-white rounded-lg disabled:opacity-50"
            >
              Add Bank
            </button>
          </div>
        )}
      </div>

      {/* Withdrawal History */}
      <div className="bg-white rounded-xl border border-brand-border p-6">
        <h2 className="text-lg font-semibold mb-4">Withdrawal History</h2>
        {withdrawals.length === 0 ? (
          <p className="text-brand-gray text-center py-4">No withdrawals yet</p>
        ) : (
          <ul className="space-y-3">
            {withdrawals.map((w) => (
              <li
                key={w.id}
                className="flex items-center justify-between p-3 bg-brand-light rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <Building2 className="w-5 h-5 text-brand-gray" />
                  <div>
                    <p className="font-medium">{w.bankAccount?.bankName}</p>
                    <p className="text-sm text-brand-gray">
                      {new Date(w.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-bold">${Number(w.amount).toFixed(2)}</p>
                  <p className="text-sm text-brand-gray">
                    ₦{Number(w.ngnAmount).toLocaleString()}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* SEP-24 Withdrawal Modal */}
      <WithdrawModal
        isOpen={showSep24Modal}
        onClose={() => setShowSep24Modal(false)}
        authToken={privyHooks.getAccessToken as any}
        walletAddress={walletAddress}
        usdcBalance={usdcBalance}
      />
    </div>
  );
}
