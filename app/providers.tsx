'use client'

import { PrivyProvider } from '@privy-io/react-auth'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID!}
      config={{
        loginMethods: ['email'],
        appearance: {
          theme: 'light',
          accentColor: '#111827',
        },
        embeddedWallets: {
          ethereum: {
            createOnLogin: 'all-users',
          },
        },
      }}
    >
      {children}
    </PrivyProvider>
  )
}

