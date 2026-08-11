import type { Metadata } from "next";
import { Inter, Sora } from "next/font/google";
import { LiveStateProvider } from "@/context/LiveStateContext";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const sora = Sora({
  variable: "--font-sora",
  subsets: ["latin"],
  weight: ["600", "700", "800"],
});

export const metadata: Metadata = {
  title: "Loot Depot OS",
  description: "The internal operating system for Loot Depot's TikTok Live selling business.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${sora.variable} h-full`}>
      <body className="min-h-full antialiased">
        <LiveStateProvider>{children}</LiveStateProvider>
      </body>
    </html>
  );
}
