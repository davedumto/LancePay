"use client";

import { PrivyProvider } from "@privy-io/react-auth";

export function Providers({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";

  // Check if Privy is properly configured
  const isPrivyConfigured =
    appId && appId !== "YOUR_PRIVY_APP_ID_HERE" && appId.startsWith("clp");

  // If Privy is not configured, render children without PrivyProvider
  if (!isPrivyConfigured) {
    console.warn(
      "⚠️ Privy not configured. Use /login-mock for demo mode or setup Privy at dashboard.privy.io",
    );
    return <>{children}</>;
  }

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email"],
        appearance: {
          theme: "light",
          accentColor: "#111827",
        },
        embeddedWallets: {
          ethereum: {
            createOnLogin: "all-users",
          },
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
