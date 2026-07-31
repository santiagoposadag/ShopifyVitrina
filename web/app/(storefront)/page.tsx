import Link from "next/link";
import { BRAND_NAME } from "@/lib/brand";
import { getActiveProducts } from "@/lib/db";
import { ProductCard } from "@/app/components/ProductCard";
import { WhatsAppButton } from "@/app/components/WhatsAppButton";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const featured = getActiveProducts().slice(0, 6);

  return (
    <div>
      <section className="relative bg-[url('/hero.jpeg')] bg-cover bg-center">
        <div className="absolute inset-0 bg-[rgba(7,65,29,0.45)] mix-blend-multiply" />
        <div className="relative mx-auto flex min-h-[60vh] max-w-6xl flex-col items-center justify-center gap-6 px-4 py-20 text-center text-white">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt={BRAND_NAME}
            className="w-48 rounded-card border-2 border-accent bg-brand p-2"
          />
          <h1 className="max-w-2xl font-heading text-4xl font-bold tracking-tight sm:text-5xl">
            Encuentra tu próxima propiedad y habla con nosotros por WhatsApp.
          </h1>
          <p className="max-w-xl text-lg text-white/90">
            Explora nuestro catálogo actualizado. Cuando algo te guste, escríbenos directo por
            WhatsApp con el código de la propiedad y te atendemos al instante.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <WhatsAppButton message={`Hola, quiero información sobre las propiedades de ${BRAND_NAME}.`}>
              Escribir por WhatsApp
            </WhatsAppButton>
            <Link
              href="/catalogo"
              className="inline-flex items-center justify-center rounded-full bg-accent px-6 py-3 font-semibold text-white transition hover:bg-white hover:text-brand"
            >
              Ver catálogo
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16">
        <div className="mb-8 flex items-end justify-between">
          <h2 className="font-heading text-2xl font-bold text-brand">Propiedades destacadas</h2>
          <Link href="/catalogo" className="text-sm font-medium text-slate-600 hover:text-brand">
            Ver todas →
          </Link>
        </div>
        {featured.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 p-10 text-center text-slate-500">
            Aún no hay propiedades publicadas. Vuelve pronto.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {featured.map((p) => (
              <ProductCard key={p.code} product={p} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
