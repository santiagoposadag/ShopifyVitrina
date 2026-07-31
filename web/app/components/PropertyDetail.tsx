import type { Product } from "@/lib/db";
import { attributeSummary, formatCOP, locationSummary } from "@/lib/format";
import { PhotoGallery } from "./PhotoGallery";
import { WhatsAppButton } from "./WhatsAppButton";

interface AttrRow {
  label: string;
  value: string;
}

interface StatCard {
  label: string;
  value: string;
  bg: string;
}

/**
 * Highlight cards for the key figures, shown above the description. Same
 * `!= null` rule as attributeRows: a stat the owner never stated renders
 * nothing. Backgrounds alternate brand-green and gold tints.
 */
function statCards(product: Product): StatCard[] {
  const a = product.attributes;
  const stats: StatCard[] = [];
  if (a.bedrooms != null)
    stats.push({ label: "Habitaciones", value: String(a.bedrooms), bg: "bg-[rgba(7,65,29,0.07)]" });
  if (a.bathrooms != null)
    stats.push({ label: "Baños", value: String(a.bathrooms), bg: "bg-[rgba(181,157,96,0.10)]" });
  if (a.area_m2 != null)
    stats.push({ label: "Área", value: `${a.area_m2} m²`, bg: "bg-[rgba(7,65,29,0.05)]" });
  if (a.estrato != null)
    stats.push({ label: "Estrato", value: String(a.estrato), bg: "bg-[rgba(181,157,96,0.07)]" });
  return stats;
}

/**
 * The Características table. Every field uses a `!= null` guard so an attribute
 * the owner never stated stays absent instead of rendering as a blank or a zero
 * — the agent is instructed never to invent these, so a missing one is real.
 */
function attributeRows(product: Product): AttrRow[] {
  const a = product.attributes;
  const rows: AttrRow[] = [];
  if (a.neighborhood) rows.push({ label: "Barrio / sector", value: a.neighborhood });
  if (a.city) rows.push({ label: "Ciudad", value: a.city });
  if (a.area_m2 != null) rows.push({ label: "Área", value: `${a.area_m2} m²` });
  if (a.lot_m2 != null) rows.push({ label: "Lote", value: `${a.lot_m2} m²` });
  if (a.bedrooms != null) rows.push({ label: "Habitaciones", value: String(a.bedrooms) });
  if (a.bathrooms != null) rows.push({ label: "Baños", value: String(a.bathrooms) });
  if (a.levels != null) rows.push({ label: "Niveles", value: String(a.levels) });
  if (a.floor != null) rows.push({ label: "Piso", value: String(a.floor) });
  if (a.elevator != null) rows.push({ label: "Ascensor", value: a.elevator ? "Sí" : "No" });
  if (a.estrato != null) rows.push({ label: "Estrato", value: String(a.estrato) });
  if (a.admin_fee != null)
    rows.push({
      label: "Administración",
      value: a.admin_fee === 0 ? "Sin administración" : formatCOP(a.admin_fee),
    });
  if (a.property_tax != null)
    rows.push({ label: "Predial", value: `${formatCOP(a.property_tax)} al año` });
  return rows;
}

/**
 * The full property page body, shared by the public /propiedad/[code] page, the
 * owner's private /preview/[code] page, and the anonymous /ver/[token] page.
 *
 * `anonymous` renders the de-branded variant for a link a colleague can reshare
 * with their own clients: it drops the "Consultar por WhatsApp" CTA (and its
 * helper line) so the page carries no route back to us. The company header/footer
 * are handled a level up — the /ver route sits outside the (storefront) layout —
 * so this component only owns the WhatsApp button. Everything else is identical,
 * on purpose: the owner reshares EXACTLY the property a customer would see.
 */
export function PropertyDetail({
  product,
  anonymous = false,
}: {
  product: Product;
  anonymous?: boolean;
}) {
  const rows = attributeRows(product);
  const stats = statCards(product);
  const location = locationSummary(product);
  const attrs = attributeSummary(product);
  const features = product.attributes.features ?? [];
  const message = `Hola, me interesa la propiedad con código ${product.code}`;

  return (
    <>
      <div className="mb-6">
        <span className="text-sm font-medium text-slate-500">Código {product.code}</span>
        <h1 className="mt-1 font-heading text-3xl font-bold text-brand">{product.title}</h1>
        {location && <p className="mt-1 text-slate-600">{location}</p>}
        {attrs && <p className="text-slate-600">{attrs}</p>}
      </div>

      {product.photos.length > 0 && (
        <PhotoGallery photos={product.photos} title={product.title} />
      )}

      <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
        <div className="md:col-span-2">
          {stats.length > 0 && (
            <section className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
              {stats.map((s) => (
                <div key={s.label} className={`rounded-lg p-4 text-center ${s.bg}`}>
                  <p className="text-xl font-semibold text-brand">{s.value}</p>
                  <p className="text-xs text-slate-600">{s.label}</p>
                </div>
              ))}
            </section>
          )}

          {product.description && (
            <section className="mb-8">
              <h2 className="mb-2 font-heading text-lg font-semibold text-brand">Descripción</h2>
              <p className="whitespace-pre-line leading-relaxed text-slate-700">
                {product.description}
              </p>
            </section>
          )}

          {rows.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-3 font-heading text-lg font-semibold text-brand">Características</h2>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                {rows.map((r) => (
                  <div key={r.label} className="flex justify-between border-b border-slate-100 py-2">
                    <dt className="text-slate-500">{r.label}</dt>
                    <dd className="font-medium text-slate-900">{r.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {features.length > 0 && (
            <section>
              <h2 className="mb-3 font-heading text-lg font-semibold text-brand">Comodidades</h2>
              <ul className="flex flex-wrap gap-2">
                {features.map((f) => (
                  <li
                    key={f}
                    className="rounded-full bg-accent/10 px-3 py-1 text-sm text-brand"
                  >
                    {f}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside className="md:col-span-1">
          <div className="sticky top-20 rounded-card bg-white p-6 shadow-card">
            <p className="text-sm text-slate-500">Precio</p>
            <p className="mb-1 text-3xl font-bold text-accent">{formatCOP(product.price)}</p>
            {product.attributes.negotiable && (
              <p className="mb-4 text-sm text-slate-500">Precio negociable</p>
            )}
            {!anonymous && (
              <>
                <WhatsAppButton message={message} className="mt-4 w-full">
                  Consultar por WhatsApp
                </WhatsAppButton>
                <p className="mt-3 text-center text-xs text-slate-400">
                  Te atenderemos con el código {product.code} ya cargado.
                </p>
              </>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
