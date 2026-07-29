"use client";

import { useState } from "react";

/**
 * The property photo mosaic. With many photos the grid would push the
 * description and price below several screens of images, so past
 * COLLAPSE_THRESHOLD the gallery starts capped at 60vh with a fade-out
 * curtain and a button to expand it. Expansion is one-way: collapsing
 * again would yank the reader back up the page.
 */
const COLLAPSE_THRESHOLD = 4;

export function PhotoGallery({ photos, title }: { photos: string[]; title: string }) {
  const [expanded, setExpanded] = useState(false);
  const collapsed = photos.length > COLLAPSE_THRESHOLD && !expanded;

  return (
    <div className={`relative mb-8 ${collapsed ? "max-h-[60vh] overflow-hidden" : ""}`}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {photos.map((src, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={src}
            src={src}
            alt={`${title} — foto ${i + 1}`}
            className={`w-full rounded-xl object-cover ${
              i === 0 ? "col-span-2 row-span-2 aspect-square md:col-span-2" : "aspect-square"
            }`}
          />
        ))}
      </div>
      {collapsed && (
        <div className="absolute inset-x-0 bottom-0 flex h-48 items-end justify-center bg-gradient-to-t from-surface via-surface/70 to-transparent pb-4">
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="rounded-full border-2 border-brand bg-white px-6 py-2 text-sm font-semibold text-brand shadow-card transition hover:bg-brand hover:text-white"
          >
            Ver más fotos ({photos.length})
          </button>
        </div>
      )}
    </div>
  );
}
