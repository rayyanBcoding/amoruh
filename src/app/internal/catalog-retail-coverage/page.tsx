"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { planRetailCoverage } from "@/lib/retail-coverage";

type Result=ReturnType<typeof planRetailCoverage>["result"] & {mode:"preview"|"applied"};
export default function CatalogRetailCoverage() {
  const [result,setResult]=useState<Result|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const stop=useRef(false);
  const preview=useCallback(async()=>{
    try { const r=await fetch("/api/internal/catalog-retail-coverage",{cache:"no-store"});const data=await r.json();if(!r.ok)throw Error(data.error);setResult(data);setError(""); }
    catch(e){setError(e instanceof Error?e.message:"Preview failed.");}
  },[]);
  useEffect(()=>{Promise.resolve().then(()=>void preview());},[preview]);
  const apply=async()=>{
    if(!result)return;
    setBusy(true);setError("");stop.current=false;
    try {
      let remaining=result.pendingProducts;
      while(remaining>0&&!stop.current){
        const r=await fetch("/api/internal/catalog-retail-coverage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({version:result.version,limit:25})});
        const data=await r.json();if(!r.ok)throw Error(data.error);setResult(data);remaining=data.pendingProducts;
        if(!data.changedProducts&&remaining>0)throw Error("No progress; refresh the preview before resuming.");
      }
    }catch(e){setError(e instanceof Error?e.message:"Apply stopped; refresh and resume.");}
    finally{setBusy(false);}
  };
  const totals=result?.mode==="applied"?result.totals:result?.currentTotals;
  return <main className="mx-auto max-w-3xl space-y-5 p-6 text-ld-white">
    <h1 className="text-2xl font-bold">Entire-catalog retail coverage</h1>
    <p>Includes in-stock, zero-stock and previously sold products. Existing notes/review flags and priced verified/manual references are preserved. Estimates display ~ and include size/basis; no auction prices or legacy MSRP are used.</p>
    <p className="text-sm text-ld-muted">Only LIVE Notes and retailReference metadata change. Inventory, costs, sales and Product.retailPrice remain untouched. Empty legacy Not verified placeholders may be filled under the approved coverage policy.</p>
    {error&&<p role="alert" className="text-ld-red">{error}</p>}
    {totals&&<section role="status" className="space-y-1 rounded border border-ld-border p-4">
      <h2 className="font-bold">{result?.mode==="applied"?"Current totals after saved batch":"Current catalog — preview only"}</h2>
      <p>Total catalog products: {totals.totalCatalogProducts} ({totals.inStock} in stock)</p>
      <p>Products with LIVE Notes: {totals.productsWithLiveNotes}</p>
      <p>Verified retail: {totals.verifiedRetail}</p><p>Estimated retail: {totals.estimatedRetail}</p><p>Manual retail: {totals.manualRetail}</p><p>Still missing any retail price: {totals.missingRetailPrice}</p>
      <p>Products pending: {result?.pendingProducts}</p>
    </section>}
    {result?.mode==="preview"&&<p>Projected after all batches: {result.projectedTotals.productsWithLiveNotes} with notes; {result.projectedTotals.verifiedRetail} verified / {result.projectedTotals.estimatedRetail} estimated / {result.projectedTotals.manualRetail} manual; {result.projectedTotals.missingRetailPrice} missing prices. Not saved yet.</p>}
    <div className="flex gap-3"><button disabled={busy} onClick={()=>void preview()} className="rounded border border-ld-border px-4 py-2">Refresh preview</button><button disabled={busy||!result||result.pendingProducts===0} onClick={()=>void apply()} className="rounded bg-ld-purple px-4 py-2 font-bold">{busy?"Applying batches…":"Apply / resume all batches"}</button>{busy&&<button onClick={()=>{stop.current=true;}} className="rounded border border-ld-border px-4 py-2">Stop after current batch</button>}</div>
    {result&&<><details><summary>Retail prices still blocked: {result.missing.length}</summary><ul>{result.missing.map((r)=><li key={r.id}>{r.product}: {r.reason}</li>)}</ul></details><details><summary>Notes still unresolved: {result.unresolvedNotes.length}</summary><ul>{result.unresolvedNotes.map((r)=><li key={r.id}>{r.product}: {r.reason}</li>)}</ul></details></>}
    <p className="text-sm text-ld-muted">Safe to stop and resume or rerun. New/renamed products outside the reviewed identity batch are listed for follow-up; they never receive another variant’s price.</p>
  </main>;
}
