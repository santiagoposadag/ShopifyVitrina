import { notFound } from "next/navigation";
import { PropertyDetail } from "@/app/components/PropertyDetail";
import { getProductByCode } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function ProductPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const product = getProductByCode(decodeURIComponent(code));
  if (!product) notFound();

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <PropertyDetail product={product} />
    </div>
  );
}
