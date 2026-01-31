"use client";

import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { useState, useEffect } from "react";

/**
 * Development Mode Banner
 * Shows when Privy is not configured, directing users to mock login
 */
export function DevModeBanner() {
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    // Check if Privy is configured (client-side only)
    const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";
    const configured =
      appId && appId !== "YOUR_PRIVY_APP_ID_HERE" && appId.startsWith("clp");
    setShowBanner(!configured);
  }, []);

  // Don't show banner if Privy is configured
  if (!showBanner) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm">
      <div className="bg-yellow-50 border-2 border-yellow-400 rounded-xl shadow-lg p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-semibold text-yellow-900 text-sm mb-1">
              Demo Mode Active
            </h3>
            <p className="text-xs text-yellow-800 mb-3">
              Privy not configured. Use mock login to test the UI.
            </p>
            <div className="flex gap-2">
              <Link
                href="/login-mock"
                className="text-xs px-3 py-1.5 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition-colors font-medium"
              >
                Mock Login
              </Link>
              <a
                href="https://dashboard.privy.io"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-3 py-1.5 border border-yellow-600 text-yellow-900 rounded-lg hover:bg-yellow-100 transition-colors font-medium"
              >
                Setup Privy
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
