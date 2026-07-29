import Link from "next/link";
import type { Product } from "@/lib/db";
import { attributeSummary, formatCOP, locationSummary } from "@/lib/format";

export function ProductCard({ product }: { product: Product }) {
  const cover = product.photos[0];
  const location = locationSummary(product);
  const attrs = attributeSummary(product);

  return (
    <Link
      href={`/propiedad/${encodeURIComponent(product.code)}`}
      className="group flex flex-col overflow-hidden rounded-card bg-white shadow-card transition hover:-translate-y-1"
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-surface">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={cover}
            alt={product.title}
            className="h-full w-full object-cover transition group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-400">
            Sin foto
          </div>
        )}
        <span className="absolute left-3 top-3 rounded-full bg-brand/90 px-2.5 py-1 text-xs font-medium text-white">
          Código {product.code}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1 p-4">
        <h3 className="line-clamp-1 font-heading font-semibold text-brand">{product.title}</h3>
        {location && <p className="text-sm text-slate-500">{location}</p>}
        {attrs && <p className="text-sm text-slate-500">{attrs}</p>}
        <p className="mt-2 text-lg font-bold text-brand">{formatCOP(product.price)}</p>
        <span className="mt-3 rounded-md border-2 border-brand py-2 text-center text-sm font-semibold text-brand transition group-hover:bg-brand group-hover:text-white">
          Ver detalles
        </span>
      </div>
    </Link>
  );
}
