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
      className="group flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-slate-100">
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
        <span className="absolute left-3 top-3 rounded-full bg-slate-900/80 px-2.5 py-1 text-xs font-medium text-white">
          Código {product.code}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1 p-4">
        <h3 className="line-clamp-1 font-semibold text-slate-900">{product.title}</h3>
        {location && <p className="text-sm text-slate-500">{location}</p>}
        {attrs && <p className="text-sm text-slate-500">{attrs}</p>}
        <p className="mt-2 text-lg font-bold text-slate-900">{formatCOP(product.price)}</p>
      </div>
    </Link>
  );
}
