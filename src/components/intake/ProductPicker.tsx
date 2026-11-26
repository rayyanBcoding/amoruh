"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { indexIntakeProducts, searchIntakeProducts, type PickerProduct } from "@/lib/intake-product-search";

type Props = {
  products: readonly PickerProduct[];
  value?: string | null;
  excludeId?: string | null;
  onSelect: (id: string) => void;
  label?: string;
};
export function ProductPicker({ products, value, excludeId, onSelect, label = "Link to Existing Product" }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const index = useMemo(() => indexIntakeProducts(products.filter((p) => p.id !== excludeId)), [products, excludeId]);
  const matches = useMemo(() => searchIntakeProducts(index, query), [index, query]);
  const results = matches.slice(0, 30);
  const selected = products.find((p) => p.id === value);
  const activeIndex = Math.min(active, results.length - 1);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const choose = (product: PickerProduct) => { close(); onSelect(product.id); };
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, query]);

  return <div className="min-w-56 max-w-sm" onBlur={(e) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
  }}>
    <button ref={trigger} type="button" aria-expanded={open} aria-controls={`${id}-list`} aria-haspopup="listbox"
      onClick={() => { setOpen(!open); setQuery(""); setActive(0); }}
      className="w-full rounded-lg border border-ld-border bg-ld-bg px-2 py-1.5 text-left text-xs text-ld-white focus:border-ld-purple">
      {selected ? `${selected.brand} ${selected.name} · ${selected.concentration} · ${selected.size}` : label} <span aria-hidden="true">⌕</span>
    </button>
    {open && <div className="mt-1 rounded-lg border border-ld-purple bg-ld-bg-elevated p-2">
      <input autoFocus role="combobox" aria-label="Search catalog products" aria-expanded="true" aria-autocomplete="list"
        aria-controls={`${id}-list`} aria-activedescendant={results[activeIndex] ? `${id}-${results[activeIndex].id}` : undefined}
        value={query} placeholder="Name, brand, SKU or barcode…"
        onChange={(e) => { setQuery(e.target.value); setActive(0); }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActive(results.length ? (activeIndex + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length : 0);
          }
          if (e.key === "Enter") { e.preventDefault(); if (results[activeIndex]) choose(results[activeIndex]); }
        }}
        className="w-full rounded border border-ld-border bg-ld-bg px-2 py-1.5 text-xs text-ld-white outline-none focus:border-ld-purple" />
      <p role="status" className="py-1 text-[11px] text-ld-muted">{matches.length ? `${matches.length} matches${matches.length > 30 ? ' · showing first 30; keep typing' : ''}` : "No products found. Try another search or create a new product."}</p>
      <div ref={list} id={`${id}-list`} role="listbox" aria-label="Catalog products" className="max-h-56 overflow-y-auto">
        {results.map((p, i) => <div key={p.id} id={`${id}-${p.id}`} role="option" aria-selected={i === activeIndex}
          onMouseDown={(e) => e.preventDefault()} onClick={() => choose(p)}
          className={`cursor-pointer rounded px-2 py-1.5 text-xs text-ld-white ${i === activeIndex ? 'bg-ld-purple/25' : 'hover:bg-ld-purple/10'}`}>
          <p className="font-bold">{p.brand} · {p.name}</p>
          <p>{p.concentration || "Concentration unspecified"} · {p.size || "Size unspecified"} · {/tester/i.test(`${p.name} ${p.condition}`) ? 'Tester' : 'Retail'} · {p.condition || "Condition unspecified"} · Stock: {p.inventory}</p>
          <p className="break-all text-[11px] text-ld-muted">{p.sku && `SKU: ${p.sku}`}{p.barcode && p.barcode !== p.sku && ` · Barcode: ${p.barcode}`}</p>
        </div>)}
      </div>
    </div>}
  </div>;
}
