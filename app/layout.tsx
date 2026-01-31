import type { Metadata } from "next";
import { Providers } from "./providers";
import { Toaster } from "sonner";
import { DevModeBanner } from "@/components/DevModeBanner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lancepay - Get Paid in Minutes, Not Days",
  description:
    "The fastest way for Nigerian freelancers to receive international payments.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <Providers>{children}</Providers>
        <Toaster position="top-right" richColors />
        <DevModeBanner />
      </body>
    </html>
  );
}
