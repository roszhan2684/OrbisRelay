import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Instrument_Serif, JetBrains_Mono } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const switzer = localFont({ src: "../fonts/Switzer-Variable.woff2", variable: "--font-switzer", weight: "100 900", display: "swap" });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"], display: "swap" });
const instrument = Instrument_Serif({ variable: "--font-instrument", subsets: ["latin"], weight: "400", style: ["normal", "italic"], display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:4310"),
  title: { default: "Orbis Relay — Human trust infrastructure for autonomous software", template: "%s · Orbis Relay" },
  description: "Before an AI agent, workflow or internal tool does something risky, it asks Orbis. Deterministic policy decides; high-impact actions go to a verified human on iPhone; every decision gets a signed receipt.",
  openGraph: { title: "Orbis Relay", description: "Control without killing autonomy.", type: "website" },
};

export const viewport: Viewport = { themeColor: "#070b17" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${switzer.variable} ${jetbrains.variable} ${instrument.variable} h-full antialiased`}>
      <body className="min-h-full font-sans">
        {children}
        <Toaster position="bottom-right" toastOptions={{ style: { fontFamily: "var(--font-switzer)" } }} />
      </body>
    </html>
  );
}
