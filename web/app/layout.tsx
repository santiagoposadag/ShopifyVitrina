import type { Metadata } from "next";
import { Inter, Poppins } from "next/font/google";
import Link from "next/link";
import { BRAND_NAME } from "@/lib/brand";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const poppins = Poppins({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-poppins" });

export const metadata: Metadata = {
  title: `${BRAND_NAME} — Propiedades`,
  description: `Catálogo de propiedades de ${BRAND_NAME}. Encontrá tu próximo hogar y escribinos por WhatsApp.`,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${inter.variable} ${poppins.variable}`}>
      <body className="min-h-screen flex flex-col">
        <header className="sticky top-0 z-10 bg-brand shadow-md">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
            <Link href="/" className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt={BRAND_NAME} className="h-10 w-auto" />
              <span className="font-heading text-lg font-bold tracking-tight text-white">
                {BRAND_NAME}
              </span>
            </Link>
            <nav className="flex items-center gap-6 text-sm font-medium text-white/80">
              <Link href="/" className="transition hover:text-accent">
                Inicio
              </Link>
              <Link href="/catalogo" className="transition hover:text-accent">
                Catálogo
              </Link>
            </nav>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="bg-brand text-white">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-4 pb-4 pt-8">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt={BRAND_NAME} className="w-32" />
            <nav className="flex items-center gap-5 text-sm font-medium">
              <Link href="/" className="transition hover:text-accent">
                Inicio
              </Link>
              <Link href="/catalogo" className="transition hover:text-accent">
                Catálogo
              </Link>
            </nav>
            <p className="text-sm text-white/80">
              © {new Date().getFullYear()} {BRAND_NAME}. Todos los derechos reservados.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
