import type { Metadata } from "next";
import Link from "next/link";
import { BRAND_NAME } from "@/lib/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: `${BRAND_NAME} — Propiedades`,
  description: `Catálogo de propiedades de ${BRAND_NAME}. Encontrá tu próximo hogar y escribinos por WhatsApp.`,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-screen flex flex-col">
        <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
            <Link href="/" className="text-lg font-bold tracking-tight text-slate-900">
              {BRAND_NAME}
            </Link>
            <nav className="flex items-center gap-6 text-sm font-medium text-slate-600">
              <Link href="/" className="hover:text-slate-900">
                Inicio
              </Link>
              <Link href="/catalogo" className="hover:text-slate-900">
                Catálogo
              </Link>
            </nav>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="border-t border-slate-200 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-6 text-sm text-slate-500">
            © {new Date().getFullYear()} {BRAND_NAME}. Todos los derechos reservados.
          </div>
        </footer>
      </body>
    </html>
  );
}
