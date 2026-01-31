'use client';

/**
 * SEP-24 Withdrawal Modal
 * 
 * Multi-step modal for withdrawing USDC via Stellar anchors (MoneyGram, Yellow Card).
 * Handles anchor selection, SEP-10 authentication, interactive iframe, and status tracking.
 */

import { useState, useEffect, useCallback } from 'react';
import { X, Building2, Banknote, Loader2, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react';

type Step = 'select-anchor' | 'enter-amount' | 'authenticate' | 'interactive' | 'confirm' | 'status';

interface Anchor {
  id: 'moneygram' | 'yellowcard';
  name: string;
  description: string;
  icon: typeof Building2;
  withdrawTypes: string[];
}

const ANCHORS: Anchor[] = [
  {
    id: 'yellowcard',
    name: 'Yellow Card',
    description: 'Bank transfer to Nigerian bank accounts',
    icon: Building2,
    withdrawTypes: ['bank_transfer'],
  },
  {
    id: 'moneygram',
    name: 'MoneyGram',
    description: 'Cash pickup at MoneyGram locations',
    icon: Banknote,
    withdrawTypes: ['cash'],
  },
];

interface WithdrawModalProps {
  isOpen: boolean;
  onClose: () => void;
  authToken: string;
  walletAddress: string;
  usdcBalance: string;
  onSignTransaction?: (transactionXdr: string, networkPassphrase: string) => Promise<string>;
}

export function WithdrawModal({
  isOpen,
  onClose,
  authToken,
  walletAddress,
  usdcBalance,
  onSignTransaction,
}: WithdrawModalProps) {
  const [step, setStep] = useState<Step>('select-anchor');
  const [selectedAnchor, setSelectedAnchor] = useState<Anchor | null>(null);
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [interactiveUrl, setInteractiveUrl] = useState<string | null>(null);
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [stellarTxId, setStellarTxId] = useState<string | null>(null);
  const [txStatus, setTxStatus] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setStep('select-anchor');
      setSelectedAnchor(null);
      setAmount('');
      setError(null);
      setInteractiveUrl(null);
      setTransactionId(null);
      setStellarTxId(null);
      setTxStatus(null);
      setStatusMessage(null);
      setIsAuthenticated(false);
    }
  }, [isOpen]);

  // Check if already authenticated with anchor
  const checkAuthStatus = useCallback(async (anchorId: string) => {
    try {
      const response = await fetch(`/api/sep24/auth?anchorId=${anchorId}`, {
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      });
      
      if (response.ok) {
        const data = await response.json();
        setIsAuthenticated(data.authenticated);
        return data.authenticated;
      }
    } catch (error) {
      console.error('Auth check error:', error);
    }
    return false;
  }, [authToken]);

  // Handle anchor selection
  const handleSelectAnchor = async (anchor: Anchor) => {
    setSelectedAnchor(anchor);
    setError(null);
    
    // Check if already authenticated
    const authed = await checkAuthStatus(anchor.id);
    if (authed) {
      setStep('enter-amount');
    } else {
      setStep('enter-amount'); // Still go to amount, auth will happen before withdrawal
    }
  };

  // Handle amount submission
  const handleAmountSubmit = async () => {
    if (!selectedAnchor || !amount) return;
    
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setError('Please enter a valid amount');
      return;
    }
    
    if (amountNum > parseFloat(usdcBalance)) {
      setError('Insufficient balance');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Check authentication first
      if (!isAuthenticated) {
        // Get challenge
        const challengeResponse = await fetch('/api/sep24/auth', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            anchorId: selectedAnchor.id,
            action: 'challenge',
          }),
        });

        if (!challengeResponse.ok) {
          const err = await challengeResponse.json();
          throw new Error(err.error || 'Failed to get challenge');
        }

        const challengeData = await challengeResponse.json();
        
        setStep('authenticate');

        // Sign the challenge with user's wallet
        if (!onSignTransaction) {
          throw new Error('Wallet signing not available');
        }

        const signedXdr = await onSignTransaction(
          challengeData.transactionXdr,
          challengeData.networkPassphrase
        );

        // Submit signed challenge
        const submitResponse = await fetch('/api/sep24/auth', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            anchorId: selectedAnchor.id,
            action: 'submit',
            signedXdr,
          }),
        });

        if (!submitResponse.ok) {
          const err = await submitResponse.json();
          throw new Error(err.error || 'Authentication failed');
        }

        setIsAuthenticated(true);
      }

      // Now initiate withdrawal
      const withdrawResponse = await fetch('/api/sep24/withdraw', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          anchorId: selectedAnchor.id,
          amount,
          asset: 'USDC',
        }),
      });

      if (!withdrawResponse.ok) {
        const err = await withdrawResponse.json();
        throw new Error(err.error || 'Failed to initiate withdrawal');
      }

      const withdrawData = await withdrawResponse.json();
      
      setTransactionId(withdrawData.transactionId);
      setStellarTxId(withdrawData.stellarTxId);
      setInteractiveUrl(withdrawData.interactiveUrl);
      setStep('interactive');
    } catch (error) {
      console.error('Withdrawal error:', error);
      setError(error instanceof Error ? error.message : 'An error occurred');
      setStep('enter-amount');
    } finally {
      setLoading(false);
    }
  };

  // Poll transaction status
  const pollStatus = useCallback(async () => {
    if (!transactionId) return;

    try {
      const response = await fetch(`/api/sep24/status?transactionId=${transactionId}`, {
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setTxStatus(data.status);
        setStatusMessage(data.statusMessage);

        // If terminal status, stop polling
        if (data.isComplete) {
          return true;
        }
      }
    } catch (error) {
      console.error('Status poll error:', error);
    }
    return false;
  }, [transactionId, authToken]);

  // Start polling when in status step
  useEffect(() => {
    if (step !== 'status' || !transactionId) return;

    const interval = setInterval(async () => {
      const isComplete = await pollStatus();
      if (isComplete) {
        clearInterval(interval);
      }
    }, 5000);

    // Initial poll
    pollStatus();

    return () => clearInterval(interval);
  }, [step, transactionId, pollStatus]);

  // Handle iframe completion (user triggers this)
  const handleInteractiveComplete = () => {
    setStep('status');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h2 className="text-xl font-semibold text-gray-900">
            {step === 'select-anchor' && 'Withdraw USDC'}
            {step === 'enter-amount' && selectedAnchor?.name}
            {step === 'authenticate' && 'Authenticating...'}
            {step === 'interactive' && 'Complete Withdrawal'}
            {step === 'status' && 'Transaction Status'}
          </h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-full transition-colors"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto" style={{ maxHeight: 'calc(90vh - 80px)' }}>
          {/* Error Display */}
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {/* Step 1: Select Anchor */}
          {step === 'select-anchor' && (
            <div className="space-y-3">
              <p className="text-sm text-gray-600 mb-4">
                Choose how you'd like to receive your funds:
              </p>
              {ANCHORS.map((anchor) => (
                <button
                  key={anchor.id}
                  onClick={() => handleSelectAnchor(anchor)}
                  className="w-full p-4 border border-gray-200 rounded-xl hover:border-brand-black hover:bg-gray-50 transition-all flex items-start gap-4 text-left"
                >
                  <div className="p-3 bg-gray-100 rounded-lg">
                    <anchor.icon className="w-6 h-6 text-gray-700" />
                  </div>
                  <div>
                    <h3 className="font-medium text-gray-900">{anchor.name}</h3>
                    <p className="text-sm text-gray-500">{anchor.description}</p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Step 2: Enter Amount */}
          {step === 'enter-amount' && selectedAnchor && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Amount (USDC)
                </label>
                <div className="relative">
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-brand-black focus:border-transparent text-lg"
                    disabled={loading}
                  />
                  <button
                    onClick={() => setAmount(usdcBalance)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-brand-black font-medium hover:underline"
                  >
                    Max
                  </button>
                </div>
                <p className="text-sm text-gray-500 mt-2">
                  Available: {usdcBalance} USDC
                </p>
              </div>

              <div className="flex gap-3 pt-4">
                <button
                  onClick={() => setStep('select-anchor')}
                  className="flex-1 px-4 py-3 border border-gray-200 rounded-xl font-medium hover:bg-gray-50 transition-colors"
                  disabled={loading}
                >
                  Back
                </button>
                <button
                  onClick={handleAmountSubmit}
                  disabled={loading || !amount || parseFloat(amount) <= 0}
                  className="flex-1 px-4 py-3 bg-brand-black text-white rounded-xl font-medium hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    'Continue'
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Authenticate */}
          {step === 'authenticate' && (
            <div className="flex flex-col items-center justify-center py-8">
              <Loader2 className="w-12 h-12 text-brand-black animate-spin mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                Signing Authentication
              </h3>
              <p className="text-sm text-gray-500 text-center">
                Please approve the signature request in your wallet to verify your account.
              </p>
            </div>
          )}

          {/* Step 4: Interactive iframe */}
          {step === 'interactive' && interactiveUrl && (
            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                Complete the withdrawal details below. This form is provided by {selectedAnchor?.name}.
              </p>
              
              <div className="border border-gray-200 rounded-xl overflow-hidden" style={{ height: '400px' }}>
                <iframe
                  src={interactiveUrl}
                  className="w-full h-full"
                  title={`${selectedAnchor?.name} Withdrawal Form`}
                  sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
                />
              </div>

              <div className="flex items-center gap-2 text-sm text-gray-500">
                <ExternalLink className="w-4 h-4" />
                <a 
                  href={interactiveUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  Open in new tab
                </a>
              </div>

              <button
                onClick={handleInteractiveComplete}
                className="w-full px-4 py-3 bg-brand-black text-white rounded-xl font-medium hover:bg-gray-800 transition-colors"
              >
                I've Completed the Form
              </button>
            </div>
          )}

          {/* Step 5: Status */}
          {step === 'status' && (
            <div className="space-y-4">
              <div className="flex flex-col items-center py-6">
                {txStatus === 'completed' ? (
                  <CheckCircle2 className="w-16 h-16 text-green-500 mb-4" />
                ) : txStatus === 'error' || txStatus === 'expired' ? (
                  <AlertCircle className="w-16 h-16 text-red-500 mb-4" />
                ) : (
                  <Loader2 className="w-16 h-16 text-brand-black animate-spin mb-4" />
                )}
                
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  {statusMessage || 'Processing...'}
                </h3>
                
                <p className="text-sm text-gray-500 text-center">
                  {txStatus === 'completed' 
                    ? 'Your withdrawal has been processed successfully.'
                    : txStatus === 'error'
                    ? 'There was an error processing your withdrawal.'
                    : 'This may take a few minutes. You can close this modal and check back later.'}
                </p>
              </div>

              {stellarTxId && (
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-xs text-gray-500 mb-1">Transaction ID</p>
                  <p className="text-sm font-mono text-gray-700 break-all">{stellarTxId}</p>
                </div>
              )}

              <button
                onClick={onClose}
                className="w-full px-4 py-3 bg-brand-black text-white rounded-xl font-medium hover:bg-gray-800 transition-colors"
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
