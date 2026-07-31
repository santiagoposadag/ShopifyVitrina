"use client";

import { useState } from "react";

/**
 * A read-only URL with a copy button, for the owner's preview page. Client-side
 * only for the clipboard interaction — the link itself is computed on the server
 * (the anon-share secret never reaches the browser) and passed in as a prop.
 */
export function CopyLinkBox({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure origin, permission) — the input is
      // selectable, so the owner can still copy by hand.
    }
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <input
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        aria-label={label}
        className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
      />
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
      >
        {copied ? "¡Copiado!" : "Copiar enlace"}
      </button>
    </div>
  );
}
