"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function LoginPage() {
  const router = useRouter();
  const { login, authenticated, ready } = usePrivy();

  // Redirect to dashboard if authenticated
  useEffect(() => {
    if (ready && authenticated) {
      router.push("/dashboard");
    }
  }, [ready, authenticated, router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-brand-light">
      <div className="max-w-md w-full mx-4">
        <div className="bg-white rounded-2xl shadow-lg p-8 text-center">
          <div className="w-16 h-16 bg-brand-black rounded-2xl flex items-center justify-center mx-auto mb-6">
            <span className="text-white font-bold text-2xl">LP</span>
          </div>

          <h1 className="text-2xl font-bold text-brand-black mb-2">
            Welcome to LancePay
          </h1>
          <p className="text-brand-gray mb-8">
            Sign in to manage your invoices and payments
          </p>

          <button
            onClick={login}
            disabled={!ready}
            className="w-full py-3 px-4 bg-brand-black text-white rounded-lg font-medium hover:bg-gray-800 transition-colors disabled:opacity-50"
          >
            {ready ? "Sign in with Email" : "Loading..."}
          </button>

          <p className="text-xs text-brand-gray mt-6">
            By signing in, you agree to our Terms of Service
          </p>
        </div>
      </div>
    </div>
  );
}
