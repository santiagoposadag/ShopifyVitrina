import type { Metadata } from "next";
import { Inter, Poppins } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const poppins = Poppins({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-poppins" });

/**
 * Neutral default title, deliberately company-free. The branded storefront pages
 * override it in (storefront)/layout.tsx; the anonymous /ver/[token] page, which
 * sits OUTSIDE that group, keeps this one so the browser tab reveals no company.
 */
export const metadata: Metadata = {
  title: "Propiedad",
};

/**
 * The root shell: html/body, fonts, globals — and nothing that identifies the
 * company. All company branding (header, footer, branded metadata) lives in
 * (storefront)/layout.tsx so the anonymous /ver/[token] page renders without it.
 * Route groups do not change URLs.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${inter.variable} ${poppins.variable}`}>
      <body className="min-h-screen flex flex-col">{children}</body>
    </html>
  );
}
