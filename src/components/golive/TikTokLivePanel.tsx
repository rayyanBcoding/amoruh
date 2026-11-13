"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Product } from "@/lib/types";
import { Button } from "@/components/Button";
import { formatCurrency } from "@/lib/format";
import { getLiveNotesView, liveNotesOneLiner } from "@/lib/live-notes";
import { computeTotals, isPaidRow, searchProducts, type ProductLite } from "@/lib/tiktok/live-totals";
import { toCents } from "@/lib/tiktok/money";
import type { PanelData, PanelRow } from "@/lib/tiktok/live-panel";

// TikTok-assisted matching for Go Live.
//
// TikTok knows the auction # and the sold price, but not which fragrance, so the host picks
// the product per auction. Choosing a product saves ONLY the TikTok-side match
// (room_id, seller_sku) → productId. PREVIEW: nothing here creates a SaleRecord, changes
// inventory / cost / profit, or writes to TikTok. The manual Go Live flow is untouched.

type Filter = "all" | "needs" | "matched" | "unpaid";
const money = (cents: number) => formatCurrency(cents / 100);

function roomLabel(r: PanelData["rooms"][number]): string {
  const when = r.firstOrderTime ? new Date(r.firstOrderTime * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : r.roomId.slice(-6);
  return `${when} · ${r.slotCount} auctions${r.unpaidSlots ? ` (${r.unpaidSlots} unpaid)` : ""}`;
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" | "warn" }) {
  const color = tone === "good" ? "text-ld-green" : tone === "bad" ? "text-ld-red" : tone === "warn" ? "text-ld-amber" : "text-ld-white";
  return (
    <div className="text-center">
      <p className="text-[10px] font-bold uppercase tracking-widest text-ld-muted">{label}</p>
      <p className={`font-display text-lg font-extrabold ${color}`}>{value}</p>
      {sub && <p className="text-[10px] font-medium text-ld-muted">{sub}</p>}
    </div>
  );
}

function Pill({ tone, children }: { tone: "good" | "bad" | "warn" | "muted"; children: React.ReactNode }) {
  const cls = tone === "good" ? "bg-ld-green/10 text-ld-green ring-ld-green/30" : tone === "bad" ? "bg-ld-red/10 text-ld-red ring-ld-red/30" : tone === "warn" ? "bg-ld-amber/10 text-ld-amber ring-ld-amber/30" : "bg-ld-bg-elevated text-ld-muted ring-ld-border";
  return <span className={`inline-block whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1 ring-inset ${cls}`}>{children}</span>;
}

export function TikTokLivePanel() {
  const [open, setOpen] = useState(true);
  const [roomSel, setRoomSel] = useState<string>("latest");
  const [panel, setPanel] = useState<PanelData | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [newestFirst, setNewestFirst] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  // typeahead
  const [activeSku, setActiveSku] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const [dropRect, setDropRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const activeEl = useRef<HTMLInputElement | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const inflight = useRef(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/tiktok/live-panel?roomId=${encodeURIComponent(roomSel)}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      if (inflight.current === 0) setPanel(body as PanelData);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load TikTok data.");
    }
  }, [roomSel]);

  const loadProducts = useCallback(async () => {
    try {
      const res = await fetch("/api/products", { cache: "no-store" });
      const data = await res.json().catch(() => []);
      if (Array.isArray(data)) setProducts(data);
    } catch {
      /* the manual Go Live flow does not depend on this */
    }
  }, []);

  // Initial load + light polling of OUR OWN stored data (not TikTok) so a partner's matches appear.
  useEffect(() => {
    Promise.resolve().then(() => {
      void load();
      void loadProducts();
    });
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 10_000);
    return () => clearInterval(t);
  }, [load, loadProducts]);

  const productsById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const lite = useMemo(() => new Map<string, ProductLite>(products.map((p) => [p.id, { id: p.id, cost: p.cost, inventory: p.inventory }])), [products]);
  const rows = useMemo(() => panel?.rows ?? [], [panel]);
  const totals = useMemo(() => computeTotals(rows, lite), [rows, lite]);

  const shown = useMemo(() => {
    const f = rows.filter((r) => {
      if (filter === "needs") return isPaidRow(r) && !(r.match && r.match.health === "OK" && productsById.has(r.match.productId));
      if (filter === "matched") return isPaidRow(r) && !!r.match && r.match.health === "OK" && productsById.has(r.match.productId);
      if (filter === "unpaid") return !isPaidRow(r);
      return true;
    });
    return newestFirst ? [...f].reverse() : f;
  }, [rows, filter, newestFirst, productsById]);

  const results = useMemo(() => (activeSku ? searchProducts(products, query, 8) : []), [products, query, activeSku]);

  const updateRect = useCallback(() => {
    const el = activeEl.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setDropRect({ left: r.left, top: r.bottom + 4, width: Math.max(r.width, 320) });
  }, []);

  useEffect(() => {
    if (!activeSku) return;
    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect);
    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect);
    };
  }, [activeSku, updateRect]);

  const patchRow = (sku: string, productId: string | null) =>
    setPanel((p) =>
      p ? { ...p, rows: p.rows.map((r) => (r.sellerSku === sku ? { ...r, match: productId ? { productId, version: (r.match?.version ?? 0) + 1, health: "OK" as const } : null } : r)) } : p
    );

  const choose = async (sku: string, productId: string | null) => {
    const roomId = panel?.roomId;
    if (!roomId) return;
    setActiveSku(null);
    setRowErrors((e) => {
      const n = { ...e };
      delete n[sku];
      return n;
    });
    patchRow(sku, productId); // instant: totals update immediately
    // Jump to the next paid auction that still needs a product RIGHT AWAY (before the save
    // finishes), so keystrokes typed immediately after Enter land in the next row.
    if (productId) {
      const idx = shown.findIndex((r) => r.sellerSku === sku);
      const next = shown.slice(idx + 1).find((r) => isPaidRow(r) && !r.match);
      if (next) setTimeout(() => inputs.current.get(next.sellerSku)?.focus(), 0);
    }
    inflight.current++;
    try {
      const res = await fetch("/api/tiktok/live-panel/match", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roomId, sellerSku: sku, productId }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    } catch (e) {
      setRowErrors((er) => ({ ...er, [sku]: e instanceof Error ? e.message : "Could not save." }));
    } finally {
      inflight.current--;
      void load(); // confirm with the server either way
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    setRefreshNote(null);
    try {
      const res = await fetch("/api/tiktok/live-panel/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roomId: roomSel }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setRefreshNote({ ok: true, text: `Updated ${new Date().toLocaleTimeString()} · ${body.orders} orders (#1–#${body.auctionNoMax}) · ${body.created} new, ${body.updated} changed` });
      await Promise.all([load(), loadProducts()]);
    } catch (e) {
      setRefreshNote({ ok: false, text: `${e instanceof Error ? e.message : "Refresh failed."} You can keep using the manual flow below.` });
    } finally {
      setRefreshing(false);
    }
  };

  const rowStatus = (r: PanelRow, productOk: boolean) => {
    if (r.state === "UNPAID_OPEN") return <Pill tone="warn">Awaiting payment</Pill>;
    if (r.state === "CONFLICT") return <Pill tone="bad">Conflict · 2 paid orders</Pill>;
    if (!isPaidRow(r)) return <Pill tone="bad">Unpaid / cancelled</Pill>;
    if (!r.match) return <Pill tone="warn">Needs product</Pill>;
    if (r.match.health !== "OK") return <Pill tone="bad">Order changed — recheck</Pill>;
    if (!productOk) return <Pill tone="bad">Product missing</Pill>;
    return <Pill tone="good">Matched</Pill>;
  };

  const paidNoRoom = !panel?.roomId;

  return (
    <div className="glass-panel rounded-2xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 text-left" aria-expanded={open}>
          <span className="font-display text-sm font-bold uppercase tracking-widest text-ld-cyan">TikTok Auctions</span>
          <span className="rounded-md bg-ld-amber/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-ld-amber ring-1 ring-inset ring-ld-amber/30">Preview · not recorded in sales or inventory</span>
          <span className="text-xs text-ld-muted">{open ? "▾ hide" : "▸ show"}</span>
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={roomSel}
            onChange={(e) => setRoomSel(e.target.value)}
            aria-label="TikTok LIVE room"
            className="rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-sm text-ld-white outline-none focus:border-ld-purple"
          >
            <option value="latest">Latest LIVE{panel?.rooms[0] ? ` — ${roomLabel(panel.rooms[0])}` : ""}</option>
            {(panel?.rooms ?? []).map((r) => (
              <option key={r.roomId} value={r.roomId}>
                {roomLabel(r)}
              </option>
            ))}
          </select>
          <Button variant="cyan" size="md" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh TikTok Orders"}
          </Button>
        </div>
      </div>

      {refreshNote && (
        <p className={`mt-2 text-xs font-medium ${refreshNote.ok ? "text-ld-green" : "text-ld-red"}`} role="status">
          {refreshNote.text}
        </p>
      )}
      {loadError && <p className="mt-2 text-xs font-medium text-ld-red">Could not read TikTok data ({loadError}). The manual flow is unaffected.</p>}

      {open && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-3 gap-3 rounded-xl border border-ld-border/60 bg-ld-bg-elevated/40 p-3 sm:grid-cols-6">
            <Tile label="Revenue" value={money(totals.revenueCents)} sub={`${totals.paidAuctions} paid · ${money(totals.paidCents)} on TikTok`} />
            <Tile label="Product Cost" value={money(totals.costCents)} sub={totals.matchedWithoutCost ? `${totals.matchedWithoutCost} w/o cost` : undefined} tone={totals.matchedWithoutCost ? "warn" : undefined} />
            <Tile label="Gross Profit" value={money(totals.profitCents)} sub={totals.marginPct !== null ? `${totals.marginPct.toFixed(1)}% margin` : undefined} tone={totals.profitCents < 0 ? "bad" : totals.unitsMatched ? "good" : undefined} />
            <Tile label="Units Matched" value={String(totals.unitsMatched)} />
            <Tile label="Needs Product" value={String(totals.unmatchedPaid)} sub={totals.unmatchedPaid ? money(totals.unmatchedPaidCents) : undefined} tone={totals.unmatchedPaid ? "warn" : "good"} />
            <Tile label="Unpaid / Cancelled" value={String(totals.unpaid)} sub="not counted" tone={totals.unpaid ? "bad" : undefined} />
          </div>
          {(totals.staleMatches > 0 || totals.missingProduct > 0) && (
            <p className="text-xs font-medium text-ld-red">
              {totals.staleMatches > 0 && `${totals.staleMatches} saved match${totals.staleMatches === 1 ? "" : "es"} no longer line up with a paid TikTok order and are excluded. `}
              {totals.missingProduct > 0 && `${totals.missingProduct} matched product${totals.missingProduct === 1 ? " was" : "s were"} deleted and ${totals.missingProduct === 1 ? "is" : "are"} excluded.`}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 text-xs">
            {(["all", "needs", "matched", "unpaid"] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`rounded-lg px-3 py-1.5 font-bold ring-1 ring-inset ${filter === f ? "bg-ld-purple/15 text-ld-white ring-ld-purple/40" : "bg-ld-bg-elevated text-ld-muted ring-ld-border hover:text-ld-white"}`}
              >
                {f === "all" ? "All" : f === "needs" ? "Needs product" : f === "matched" ? "Matched" : "Unpaid / cancelled"}
              </button>
            ))}
            <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-ld-muted">
              <input type="checkbox" checked={newestFirst} onChange={(e) => setNewestFirst(e.target.checked)} /> Newest first
            </label>
            {panel?.roomUpdatedAt && <span className="text-ld-muted">Imported {new Date(panel.roomUpdatedAt).toLocaleTimeString()}</span>}
          </div>

          {paidNoRoom ? (
            <p className="rounded-xl border border-ld-border bg-ld-bg-elevated/40 px-4 py-6 text-center text-sm text-ld-muted">
              No TikTok room is loaded yet. Press <b>Refresh TikTok Orders</b> after the first sale.
            </p>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto rounded-xl border border-ld-border/60">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-ld-bg-elevated text-[10px] font-bold uppercase tracking-widest text-ld-muted">
                  <tr>
                    <th className="px-3 py-2 text-left">#</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-left">Product</th>
                    <th className="px-3 py-2 text-right">Stock</th>
                    <th className="px-3 py-2 text-right">Cost</th>
                    <th className="px-3 py-2 text-right">Profit</th>
                    <th className="px-3 py-2 text-left">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const paid = isPaidRow(r);
                    const prod = r.match ? productsById.get(r.match.productId) : undefined;
                    const counted = paid && !!r.match && r.match.health === "OK" && !!prod;
                    const cents = toCents(r.salePrice);
                    const cost = counted && prod && prod.cost > 0 ? Math.round(prod.cost * 100) : null;
                    const used = prod ? totals.usage[prod.id] ?? 0 : 0;
                    return (
                      <tr key={r.sellerSku} className={`border-t border-ld-border/40 ${paid ? "" : "bg-ld-red/5 opacity-75"}`}>
                        <td className="px-3 py-1.5 font-display font-extrabold text-ld-white">{r.sellerSku}</td>
                        <td className={`px-3 py-1.5 text-right font-semibold ${paid ? "text-ld-white" : "text-ld-muted line-through"}`}>{cents !== null ? money(cents) : "—"}</td>
                        <td className="px-3 py-1.5">
                          {paid ? (
                            <>
                            <div className="flex items-center gap-1">
                              <input
                                ref={(el) => {
                                  if (el) inputs.current.set(r.sellerSku, el);
                                  else inputs.current.delete(r.sellerSku);
                                }}
                                value={activeSku === r.sellerSku ? query : prod ? `${prod.brand} ${prod.name}${prod.size ? ` ${prod.size}` : ""}` : ""}
                                placeholder={prod ? "" : "Select product…"}
                                aria-label={`Product for auction ${r.sellerSku}`}
                                onFocus={(e) => {
                                  activeEl.current = e.currentTarget;
                                  setActiveSku(r.sellerSku);
                                  setQuery("");
                                  setHi(0);
                                  updateRect();
                                  e.currentTarget.select();
                                }}
                                onBlur={() => setActiveSku((s) => (s === r.sellerSku ? null : s))}
                                onChange={(e) => {
                                  setQuery(e.target.value);
                                  setHi(0);
                                  updateRect();
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "ArrowDown") {
                                    e.preventDefault();
                                    setHi((h) => Math.min(h + 1, Math.max(results.length - 1, 0)));
                                  } else if (e.key === "ArrowUp") {
                                    e.preventDefault();
                                    setHi((h) => Math.max(h - 1, 0));
                                  } else if (e.key === "Enter") {
                                    e.preventDefault();
                                    const pick = results[hi];
                                    if (pick) void choose(r.sellerSku, pick.id);
                                  } else if (e.key === "Escape") {
                                    e.currentTarget.blur();
                                  }
                                }}
                                className="w-full min-w-[220px] rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-1.5 text-sm text-ld-white outline-none placeholder:text-ld-muted/60 focus:border-ld-purple focus:ring-2 focus:ring-ld-purple/15"
                              />
                              {r.match && (
                                <button type="button" aria-label={`Clear product for auction ${r.sellerSku}`} onClick={() => void choose(r.sellerSku, null)} className="rounded-md px-2 py-1 text-ld-muted hover:bg-ld-bg-elevated hover:text-ld-red">
                                  ×
                                </button>
                              )}
                            </div>
                            {prod && liveNotesOneLiner(getLiveNotesView(prod)) && (
                              <p className="mt-0.5 max-w-[420px] truncate text-xs font-medium text-ld-cyan" title={liveNotesOneLiner(getLiveNotesView(prod))}>
                                {liveNotesOneLiner(getLiveNotesView(prod))}
                              </p>
                            )}
                            </>
                          ) : (
                            <span className="text-xs text-ld-muted">matching disabled</span>
                          )}
                        </td>
                        <td className={`px-3 py-1.5 text-right ${counted && prod && used > prod.inventory ? "font-bold text-ld-red" : "text-ld-muted"}`} title={counted && prod && used > prod.inventory ? `${used} matched but only ${prod.inventory} in stock` : undefined}>
                          {counted && prod ? (used > prod.inventory ? `${prod.inventory} (${used} used)` : prod.inventory) : "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right text-ld-muted">{cost !== null ? money(cost) : counted ? "no cost" : "—"}</td>
                        <td className={`px-3 py-1.5 text-right font-semibold ${cost !== null && cents !== null ? (cents - cost < 0 ? "text-ld-red" : "text-ld-green") : "text-ld-muted"}`}>{cost !== null && cents !== null ? money(cents - cost) : "—"}</td>
                        <td className="px-3 py-1.5">
                          {rowStatus(r, !!prod)}
                          {rowErrors[r.sellerSku] && <p className="mt-0.5 text-[11px] font-medium text-ld-red">{rowErrors[r.sellerSku]}</p>}
                        </td>
                      </tr>
                    );
                  })}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-3 py-6 text-center text-sm text-ld-muted">
                        {rows.length === 0 ? "No auctions in this room yet." : "Nothing matches this filter."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[11px] text-ld-muted">Profit uses each product&apos;s current unit cost. Selecting a product saves only the TikTok match — record the sale in AMORUH the usual way below.</p>
        </div>
      )}

      {activeSku && dropRect && query.trim() && (
        <div style={{ position: "fixed", left: dropRect.left, top: dropRect.top, width: dropRect.width }} className="z-50 max-h-80 overflow-y-auto rounded-xl border border-ld-border bg-ld-bg-elevated p-1 shadow-xl" role="listbox">
          {results.length === 0 ? (
            <p className="px-3 py-2 text-sm text-ld-muted">No product matches “{query}”.</p>
          ) : (
            results.map((p, i) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={i === hi}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus so the row doesn't blur before the click lands
                  void choose(activeSku, p.id);
                }}
                onMouseEnter={() => setHi(i)}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm ${i === hi ? "bg-ld-purple/15 text-ld-white" : "text-ld-white hover:bg-ld-border/30"}`}
              >
                <span className="min-w-0">
                  <span className="block truncate">
                    <b>{p.brand}</b> {p.name} {p.size}
                    <span className="ml-2 text-xs text-ld-muted">{p.sku}</span>
                  </span>
                  {liveNotesOneLiner(getLiveNotesView(p)) && (
                    <span className="block truncate text-xs font-medium text-ld-cyan">{liveNotesOneLiner(getLiveNotesView(p))}</span>
                  )}
                </span>
                <span className={`shrink-0 text-xs font-bold ${p.inventory > 0 ? "text-ld-muted" : "text-ld-red"}`}>
                  {p.inventory} in stock · {p.cost > 0 ? formatCurrency(p.cost) : "no cost"}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
