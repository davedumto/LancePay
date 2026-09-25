"use client";

import { useState, useEffect } from "react";
import { ArrowUpRight, Plus, Building2 } from "lucide-react";
import { usePrivy } from "@privy-io/react-auth";

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
  const [balance, setBalance] = useState<any>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { getAccessToken } = usePrivy();

  useEffect(() => {
    async function load() {
      const token = await getAccessToken();
      if (!token) {
        setIsLoading(false);
        return;
      }

      const [rateRes, banksRes, withdrawRes, balanceRes] = await Promise.all([
        fetch("/api/exchange-rate"),
        fetch("/api/bank-accounts", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/withdrawals", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/user/balance", { headers: { Authorization: `Bearer ${token}` } }),
      ]);

      if (rateRes.ok) setRate((await rateRes.json()).rate);
      if (banksRes.ok) {
        const d = await banksRes.json();
        setBankAccounts(d.bankAccounts);
        setBanks(d.banks || {});
        if (d.bankAccounts[0]) setSelectedBank(d.bankAccounts[0].id);
      }
      if (withdrawRes.ok) setWithdrawals((await withdrawRes.json()).withdrawals);
      if (balanceRes.ok) setBalance(await balanceRes.json());
      setIsLoading(false);
    }
    load();
  }, []);

  const addBankAccount = async () => {
    const token = await getAccessToken();
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
    if (!amount || !selectedBank || isSubmitting) return;
    const token = await getAccessToken();
    if (!token) return;
    setIsSubmitting(true);
    // Idempotency key ensures a rapid double-click / retry with the same
    // key is a no-op on the backend instead of two real bank payouts.
    const idempotencyKey =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const res = await fetch("/api/withdrawals", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          amount: parseFloat(amount),
          bankAccountId: selectedBank,
          idempotencyKey,
        }),
      });
      if (res.ok) {
        const w = await res.json();
        setWithdrawals([w, ...withdrawals]);
        setAmount("");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) return <div className="animate-pulse">Loading...</div>;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-3xl font-bold text-brand-black">Withdrawals</h1>

      {/* Exchange Rate Card */}
      <div className="bg-white rounded-xl border border-brand-border p-6">
        <p className="text-sm text-brand-gray mb-1">Current Rate</p>
        <p className="text-2xl font-bold text-brand-black">
          ₦{rate.toLocaleString()} / $1
        </p>
        {balance?.usdc && (
          <p className="text-sm text-brand-gray mt-1">
            Available: {balance.usdc} USDC
          </p>
        )}
      </div>

      {/* Withdraw Card */}
      <div className="bg-white rounded-xl border border-brand-border p-6 space-y-4">
        <h2 className="text-lg font-semibold">Withdraw to Nigerian Bank</h2>

        {bankAccounts.length === 0 ? (
          <p className="text-brand-gray">Add a bank account to withdraw</p>
        ) : (
          <>
            <div>
              <label className="block text-sm font-medium mb-2">Bank Account</label>
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
              <label className="block text-sm font-medium mb-2">Amount (USD)</label>
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
              disabled={!amount || isSubmitting}
              className="w-full py-3 bg-brand-black text-white rounded-lg font-medium hover:bg-gray-800 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <ArrowUpRight className="w-5 h-5" /> {isSubmitting ? 'Processing...' : 'Withdraw'}
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
              onChange={(e) => setNewBank({ ...newBank, bankCode: e.target.value })}
              className="w-full px-4 py-3 border border-brand-border rounded-lg bg-white"
            >
              <option value="">Select Bank</option>
              {Object.entries(banks).map(([code, name]) => (
                <option key={code} value={code}>{name}</option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Account Number (10 digits)"
              maxLength={10}
              value={newBank.accountNumber}
              onChange={(e) => setNewBank({ ...newBank, accountNumber: e.target.value })}
              className="w-full px-4 py-3 border border-brand-border rounded-lg"
            />
            <button
              onClick={addBankAccount}
              disabled={!newBank.bankCode || newBank.accountNumber.length !== 10}
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
                  <p className="text-xs capitalize text-brand-gray">{w.status}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
