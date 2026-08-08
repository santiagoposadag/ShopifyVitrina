import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { CopyLinkBox } from "@/app/components/CopyLinkBox";
import { PropertyDetail } from "@/app/components/PropertyDetail";
import { anonToken, hasAnonShare } from "@/lib/anon";
import { getProductForPreview } from "@/lib/db";
import { ANON_BASE_URL } from "@/lib/hosts";

export const dynamic = "force-dynamic";

/**
 * noindex is the one hard requirement of this page. A draft is by definition
 * UNREVIEWED data — the assistant has been caught inventing an attribute on a
 * real listing — and a wrong fact about a real property indexed by a search
 * engine is durable damage that outlives the draft itself.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

const STATUS_LABELS: Record<string, string> = {
  draft: "borrador",
  sold: "vendida",
  inactive: "inactiva",
  active: "publicada",
};

/**
 * The owner's view of a property in ANY status — how a draft gets reviewed
 * before publishing, which the catalog (active only) cannot show.
 *
 * Unlisted and noindex'd rather than access-controlled: for this pilot the
 * catalog holds no sensitive data, so an unpublished listing being reachable by
 * whoever has (or guesses) the URL is an accepted tradeoff.
 */
export default async function PreviewPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const product = getProductForPreview(decodeURIComponent(code));
  if (!product) notFound();

  const status = STATUS_LABELS[product.status] ?? product.status;
  const isPublished = product.status === "active";

  // The anonymous link only exists once the property is active (it resolves over
  // the active catalog). Built from the configured ANONYMOUS host and NOT from
  // the request host: this page is served on the BRANDED domain, so deriving the
  // host from the request would hand the owner a "de-branded" link whose domain
  // names the company. The token is computed server-side (the secret never
  // reaches the browser).
  // Unconfigured, it falls back to the request host — that is a dev machine with
  // no domains set, where the request host is the only host there is.
  let anonShareUrl: string | null = null;
  if (isPublished && hasAnonShare()) {
    let base = ANON_BASE_URL;
    if (!base) {
      const h = await headers();
      const host = h.get("host");
      base = host ? `${h.get("x-forwarded-proto") ?? "http"}://${host}` : "";
    }
    if (base) anonShareUrl = `${base}/ver/${anonToken(product.code)}`;
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <div className="mb-8 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
        <p className="font-semibold text-amber-900">Vista previa · {status}</p>
        <p className="mt-1 text-sm text-amber-800">
          {isPublished
            ? "Esta propiedad ya está publicada y aparece en el catálogo."
            : "Así se verá la propiedad cuando la publiques. Todavía no está publicada: no aparece en el catálogo ni en los buscadores. Revisa que los datos estén correctos antes de publicarla."}
        </p>
      </div>

      {anonShareUrl && (
        <div className="mb-8 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
          <p className="font-semibold text-slate-800">Enlace anónimo para compartir</p>
          <p className="mb-3 mt-1 text-sm text-slate-600">
            Enlace sin la marca de la empresa y sin el botón de WhatsApp. Compártelo con
            un colega para que lo reenvíe a sus clientes sin dirigirlos a nosotros.
          </p>
          <CopyLinkBox url={anonShareUrl} label="Enlace anónimo de la propiedad" />
        </div>
      )}

      <PropertyDetail product={product} />
    </div>
  );
}
