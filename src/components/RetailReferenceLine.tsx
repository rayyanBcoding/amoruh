"use client";
import { useState } from "react";
import { isVerifiedRetail, retailIdentity, type RetailIdentity, type RetailReference } from "@/lib/retail-reference";

type Props = { product: RetailIdentity & { id: string; retailReference?: RetailReference | null } };
export function RetailReferenceLine({ product }: Props) {
  const [saved, setSaved] = useState<RetailReference | null | undefined>(undefined);
  const reference = saved === undefined ? product.retailReference : saved;
  const verified = isVerifiedRetail({ ...product, retailReference: reference });
  const [editing, setEditing] = useState(false);
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("");
  const [retailer, setRetailer] = useState("Nordstrom");
  const [url, setUrl] = useState("");
  const [date, setDate] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const edit = () => {
    setPrice(reference?.priceCents != null ? (reference.priceCents / 100).toFixed(2) : "");
    setSize(reference?.referenceSize ?? ""); setRetailer(reference?.retailer ?? "Nordstrom");
    setUrl(reference?.sourceUrl ?? ""); setDate((reference?.checkedAt ?? new Date().toISOString()).slice(0, 10));
    setError(""); setEditing(true);
  };
  const save = async (unverified = false) => {
    if (!unverified && !/^\d+(\.\d{1,2})?$/.test(price)) { setError("Enter a dollar amount with at most two decimals."); return; }
    const [dollars, cents = ""] = price.split(".");
    const amount = Number(dollars) * 100 + Number((cents + "00").slice(0, 2));
    const next: RetailReference = {
      status: unverified ? "not_verified" : "verified", priceCents: unverified ? null : amount, currency: "USD",
      referenceSize: unverified ? null : size.trim(), concentration: product.concentration,
      retailer: unverified ? null : retailer, sourceUrl: unverified ? null : url.trim(),
      checkedAt: date ? `${date}T12:00:00Z` : new Date().toISOString(), identityKey: retailIdentity(product),
      manuallyEdited: true, verificationNotes: unverified ? "Marked not verified by operator." : "Regular price and full-size/set match checked by operator.",
    };
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/products/${product.id}/retail-reference`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ retailReference: next, expectedReference: reference ?? null }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save.");
      setSaved(data); setEditing(false);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save."); }
    finally { setBusy(false); }
  };
  const input = "w-full rounded border border-ld-border bg-ld-bg p-2 text-sm text-ld-white";
  return <div className="mt-3 border-t border-ld-purple/30 pt-3">
    <div className="flex items-center justify-between gap-2">
      <p className="font-bold text-ld-white">{verified && reference ? `Full-size retail: ~$${(reference.priceCents! / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} (${reference.referenceSize})` : "Retail: Not verified"}</p>
      {!editing && <button type="button" onClick={edit} className="text-xs text-ld-muted">Edit retail</button>}
    </div>
    {verified && reference?.sourceUrl && <p className="text-xs text-ld-muted">Source: <a href={reference.sourceUrl} target="_blank" rel="noopener noreferrer">{reference.retailer === "Official brand website" ? product.brand : reference.retailer}</a> · {reference.checkedAt.slice(0, 10)}</p>}
    {editing && <div className="mt-2 space-y-2">
      <p className="text-xs text-ld-muted">Use the exact fragrance and concentration, 100 mL or largest standard size if unavailable; exact set for gifts. Regular USD price only.</p>
      <label className="block text-xs text-ld-muted">Retail price ($)<input className={input} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" /></label>
      <label className="block text-xs text-ld-muted">Reference size / exact set<input className={input} value={size} onChange={(e) => setSize(e.target.value)} placeholder="100 mL" /></label>
      <label className="block text-xs text-ld-muted">Source<select className={input} value={retailer} onChange={(e) => setRetailer(e.target.value)}>{["Sephora", "Ulta", "Nordstrom", "Neiman Marcus", "Bloomingdale’s", "Macy’s", "Saks Fifth Avenue", "Official brand website"].map((s) => <option key={s}>{s}</option>)}</select></label>
      <label className="block text-xs text-ld-muted">Source URL<input className={input} value={url} onChange={(e) => setUrl(e.target.value)} type="url" /></label>
      <label className="block text-xs text-ld-muted">Date checked<input className={input} value={date} onChange={(e) => setDate(e.target.value)} type="date" /></label>
      {error && <p className="text-xs text-ld-red" role="alert">{error}</p>}
      <button type="button" disabled={busy} onClick={() => void save()} className="mr-3 text-sm text-ld-cyan">{busy ? "Saving…" : "Save retail"}</button>
      <button type="button" disabled={busy} onClick={() => void save(true)} className="mr-3 text-sm text-ld-muted">Not verified</button>
      <button type="button" disabled={busy} onClick={() => setEditing(false)} className="text-sm text-ld-muted">Cancel</button>
    </div>}
  </div>;
}
