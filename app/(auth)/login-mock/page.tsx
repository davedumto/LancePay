"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * MOCK LOGIN PAGE - FOR DEVELOPMENT/DEMO ONLY
 *
 * This bypasses Privy authentication and creates a fake session.
 * Use this to test the UI without setting up Privy.
 *
 * Access at: http://localhost:3000/login-mock
 *
 * WARNING: DO NOT USE IN PRODUCTION
 */

export default function MockLoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const handleMockLogin = async () => {
    setLoading(true);

    // Simulate login delay
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Create mock session in localStorage
    const mockUser = {
      id: "mock-user-123",
      email: "demo@lancepay.app",
      name: "Demo User",
      wallet: {
        address: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      },
      authenticated: true,
      createdAt: new Date().toISOString(),
    };

    localStorage.setItem("mock-auth", JSON.stringify(mockUser));

    // Redirect to dashboard
    router.push("/dashboard");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-brand-light">
      <div className="max-w-md w-full mx-4">
        <div className="bg-white rounded-2xl shadow-lg p-8 text-center">
          <div className="w-16 h-16 bg-brand-black rounded-2xl flex items-center justify-center mx-auto mb-6">
            <span className="text-white font-bold text-2xl">LP</span>
          </div>

          <h1 className="text-2xl font-bold text-brand-black mb-2">
            Mock Login (Demo Mode)
          </h1>
          <p className="text-brand-gray mb-4">
            This is a development-only login that bypasses Privy authentication.
          </p>

          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6 text-left">
            <p className="text-sm text-yellow-800 font-medium mb-2">
              ⚠️ Demo Mode
            </p>
            <ul className="text-xs text-yellow-700 space-y-1">
              <li>• No real authentication</li>
              <li>• API calls will fail without database</li>
              <li>• For UI testing only</li>
              <li>• Not for production use</li>
            </ul>
          </div>

          <button
            onClick={handleMockLogin}
            disabled={loading}
            className="w-full py-3 px-4 bg-brand-black text-white rounded-lg font-medium hover:bg-gray-800 transition-colors disabled:opacity-50 mb-4"
          >
            {loading ? "Logging in..." : "Continue as Demo User"}
          </button>

          <a
            href="/login"
            className="text-sm text-brand-gray hover:text-brand-black transition-colors"
          >
            Use real Privy login instead
          </a>

          <div className="mt-6 pt-6 border-t border-gray-200">
            <p className="text-xs text-brand-gray mb-2">
              To use real authentication:
            </p>
            <ol className="text-xs text-left text-brand-gray space-y-1">
              <li>1. Get Privy App ID from dashboard.privy.io</li>
              <li>2. Add to .env.local</li>
              <li>3. Restart dev server</li>
              <li>4. Use /login page</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
