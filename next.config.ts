import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,

  // Configure headers for SEP-24 iframe embedding
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // Allow iframes from anchor domains
              "frame-src 'self' https://*.moneygram.com https://stellar.moneygram.com https://*.yellowcard.io https://stellar.yellowcard.io https://*.stellar.org",
              // Allow API calls to anchors and Stellar Horizon
              "connect-src 'self' https://horizon.stellar.org https://horizon-testnet.stellar.org https://*.moneygram.com https://stellar.moneygram.com https://*.yellowcard.io https://stellar.yellowcard.io https://api.yellowcard.io",
              // Script and style sources
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              // Images
              "img-src 'self' data: https: blob:",
              // Fonts
              "font-src 'self' data: https://fonts.gstatic.com",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
