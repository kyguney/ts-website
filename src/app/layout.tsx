import type { Metadata, Viewport } from "next";
import { Space_Grotesk, Inter } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
  display: "swap",
});

const SITE_URL = "https://trendscore.io";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "TrendScore — AI Long/Short Signals for Crypto | Coming Soon",
  description:
    "TrendScore.io — AI-powered long/short predictions for the crypto market. Multi-agent market scanning, regime detection, and momentum signals. Launching soon.",
  icons: {
    icon: "/favicon.svg",
  },
  openGraph: {
    title: "TrendScore.io — AI Long/Short Signals for Crypto",
    description:
      "AI-powered long/short predictions for the crypto market. Launching soon.",
    type: "website",
    url: SITE_URL,
    siteName: "TrendScore",
  },
  twitter: {
    card: "summary_large_image",
    title: "TrendScore.io — AI Long/Short Signals for Crypto",
    description:
      "AI-powered long/short predictions for the crypto market. Launching soon.",
  },
};

export const viewport: Viewport = {
  themeColor: "#060810",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${inter.variable}`}>
      <body>{children}</body>
    </html>
  );
}
