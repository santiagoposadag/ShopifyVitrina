import Link from "next/link";
import { BRAND_NAME } from "@/lib/brand";
import { getActiveProducts } from "@/lib/db";
import { ProductCard } from "./components/ProductCard";
import { WhatsAppButton } from "./components/WhatsAppButton";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const featured = getActiveProducts().slice(0, 6);

  return (
    <div>
      <section className="bg-gradient-to-b from-white to-slate-50">
        <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 py-20">
          <span className="rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-white">
            {BRAND_NAME}
          </span>
          <h1 className="max-w-2xl text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
            Encontrá tu próxima propiedad y hablá con nosotros por WhatsApp.
          </h1>
          <p className="max-w-xl text-lg text-slate-600">
            Explorá nuestro catálogo actualizado. Cuando algo te guste, escribinos directo por
            WhatsApp con el código de la propiedad y te atendemos al instante.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <WhatsAppButton message={`Hola, quiero información sobre las propiedades de ${BRAND_NAME}.`}>
              Escribir por WhatsApp
            </WhatsAppButton>
            <Link
              href="/catalogo"
              className="inline-flex items-center justify-center rounded-full border border-slate-300 px-6 py-3 font-semibold text-slate-800 transition hover:bg-slate-100"
            >
              Ver catálogo
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16">
        <div className="mb-8 flex items-end justify-between">
          <h2 className="text-2xl font-bold text-slate-900">Propiedades destacadas</h2>
          <Link href="/catalogo" className="text-sm font-medium text-slate-600 hover:text-slate-900">
            Ver todas →
          </Link>
        </div>
        {featured.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 p-10 text-center text-slate-500">
            Aún no hay propiedades publicadas. Volvé pronto.
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
