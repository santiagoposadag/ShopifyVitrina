import type { Metadata } from "next";
import Link from "next/link";
import { BRAND_NAME } from "@/lib/brand";

/**
 * The branded metadata (company name in the tab, WhatsApp-flavored description)
 * lives here, not in the root layout, so it wraps the public storefront pages
 * only. The anonymous /ver/[token] page sits outside this route group and keeps
 * the root layout's neutral title instead.
 */
export const metadata: Metadata = {
  title: `${BRAND_NAME} — Propiedades`,
  description: `Catálogo de propiedades de ${BRAND_NAME}. Encuentra tu próximo hogar y escríbenos por WhatsApp.`,
};

/**
 * The company chrome — branded header and footer — around every public page.
 * It lives in this route group rather than the root layout precisely so the
 * anonymous /ver/[token] page, which is NOT in the group, renders with no
 * company branding at all. Route groups do not affect the URL.
 */
export default function StorefrontLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="sticky top-0 z-10 bg-brand shadow-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link href="/" className="flex items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt={BRAND_NAME} className="h-10 w-auto" />
            <span className="sr-only">{BRAND_NAME}</span>
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
          <p className="text-xs text-white/50">Impulsado por Vitrina</p>
        </div>
      </footer>
    </>
  );
}
