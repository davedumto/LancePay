import type { Metadata } from "next";
import { Providers } from "./providers";
import { Toaster } from "sonner";
import { DevModeBanner } from "@/components/DevModeBanner";
import { getNonce } from "@/lib/csp-nonce";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://lancepay.com";
const defaultOgImage = `${siteUrl}/og-image.jpg`;

export const metadata: Metadata = {
  title: "Lancepay - Get Paid in Minutes, Not Days",
  description:
    "The fastest way for Nigerian freelancers to receive international payments. Instant settlements, multi-sig escrow protection, and built-in dispute resolution.",
  keywords: [
    "freelance payments",
    "international transfers",
    "Nigeria",
    "Stellar blockchain",
    "escrow",
    "fast payments",
  ],
  authors: [{ name: "Lancepay Team" }],
  creator: "Lancepay",
  publisher: "Lancepay",
  metadataBase: new URL(siteUrl),
  alternates: {
    canonical: siteUrl,
  },
  openGraph: {
    type: "website",
    url: siteUrl,
    title: "Lancepay - Get Paid in Minutes, Not Days",
    description:
      "The fastest way for Nigerian freelancers to receive international payments. Instant settlements, multi-sig escrow protection, and built-in dispute resolution.",
    siteName: "Lancepay",
    locale: "en_NG",
    images: [
      {
        url: defaultOgImage,
        width: 1200,
        height: 630,
        alt: "Lancepay - Fast International Payments for Nigerian Freelancers",
        type: "image/jpeg",
      },
      {
        url: `${siteUrl}/og-image-square.jpg`,
        width: 800,
        height: 800,
        alt: "Lancepay Logo",
        type: "image/jpeg",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@lancepay",
    creator: "@lancepay",
    title: "Lancepay - Get Paid in Minutes, Not Days",
    description:
      "The fastest way for Nigerian freelancers to receive international payments.",
    images: [defaultOgImage],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Lancepay",
  },
  formatDetection: {
    telephone: false,
    email: false,
    address: false,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  category: "finance",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const nonce = await getNonce();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;700&family=Space+Mono:wght@400;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body suppressHydrationWarning>
        <Providers>{children}</Providers>
        <Toaster position="top-right" richColors />
        <DevModeBanner nonce={nonce} />
      </body>
    </html>
  );
}
