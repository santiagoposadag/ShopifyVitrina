import { getActiveProducts } from "@/lib/db";
import { ProductCard } from "../components/ProductCard";

export const dynamic = "force-dynamic";

export default function CatalogPage() {
  const products = getActiveProducts();

  return (
    <div className="mx-auto max-w-6xl px-4 py-12">
      <h1 className="mb-2 font-heading text-3xl font-bold text-brand">Catálogo</h1>
      <p className="mb-8 text-slate-600">
        {products.length} {products.length === 1 ? "propiedad disponible" : "propiedades disponibles"}
      </p>

      {products.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-10 text-center text-slate-500">
          Aún no hay propiedades publicadas.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => (
            <ProductCard key={p.code} product={p} />
          ))}
        </div>
      )}
    </div>
  );
}
