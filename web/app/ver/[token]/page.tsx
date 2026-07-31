import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PropertyDetail } from "@/app/components/PropertyDetail";
import { getProductByShareToken } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * noindex: this is a link meant for direct, private sharing between agents, not
 * a page for a crawler — and it deliberately omits the branding that would tie a
 * listing back to us. The neutral <title> comes from the root layout.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * The ANONYMOUS, de-branded property page. Same body as /propiedad/[code], but
 * reached by an opaque token instead of the code and rendered with NO company
 * header/footer (it sits outside the (storefront) route group) and NO WhatsApp
 * button (PropertyDetail's `anonymous` prop). A colleague can reshare this link
 * with their own clients without routing them back to us.
 *
 * Only active products resolve (see getProductByShareToken); a stale, unknown,
 * or unconfigured token 404s.
 */
export default async function AnonymousPropertyPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const product = getProductByShareToken(decodeURIComponent(token));
  if (!product) notFound();

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <PropertyDetail product={product} anonymous />
    </div>
  );
}
