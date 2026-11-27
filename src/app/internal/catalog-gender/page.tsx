"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { planCatalogGender } from "@/lib/catalog-gender";
type Result=ReturnType<typeof planCatalogGender>["result"] & {mode:"preview"|"applied"};
export default function CatalogGenderPage(){
  const [result,setResult]=useState<Result|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const stop=useRef(false);
  const preview=useCallback(async()=>{
    try{const r=await fetch('/api/internal/catalog-gender',{cache:'no-store'});const data=await r.json();if(!r.ok)throw Error(data.error);setResult(data);setError('');}
    catch(e){setError(e instanceof Error?e.message:'Preview failed.');}
  },[]);
  useEffect(()=>{Promise.resolve().then(()=>void preview());},[preview]);
  const apply=async()=>{
    if(!result)return;setBusy(true);stop.current=false;setError('');
    try{let pending=result.pendingProducts;
      while(pending>0&&!stop.current){const r=await fetch('/api/internal/catalog-gender',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:result.version,limit:25})});const data=await r.json();if(!r.ok)throw Error(data.error);setResult(data);pending=data.pendingProducts;if(!data.changedProducts&&pending>0)throw Error('No progress; refresh preview.');}
    }catch(e){setError(e instanceof Error?e.message:'Apply stopped; refresh and resume.');}finally{setBusy(false);}
  };
  const totals=result?.mode==='applied'?result.totals:result?.currentTotals;
  return <main className="mx-auto max-w-3xl space-y-4 p-6 text-ld-white">
    <h1 className="text-2xl font-bold">Inventory audience labels</h1>
    <p>Add Men, Women or Unisex to the entire catalog, including sold-out products. These are fragrance market categories; anyone can wear any fragrance. Existing labels are preserved and can be changed in the product editor.</p>
    <p>Only the audience label changes. Stock, costs, notes, retail prices, receipts and sales stay untouched.</p>
    {error&&<p role="alert" className="text-ld-red">{error}</p>}
    {totals&&<div role="status" className="rounded border border-ld-border p-4">
      <p>{result?.mode==='applied'?'Current totals after saved batch':'Current catalog — preview only'}</p>
      <p>{totals.total} products · Men: {totals.men} · Women: {totals.women} · Unisex: {totals.unisex} · Missing: {totals.missing}</p>
      <p>Products pending: {result?.pendingProducts}</p>
    </div>}
    {result?.mode==='preview'&&<p>Projected: Men {result.projectedTotals.men} / Women {result.projectedTotals.women} / Unisex {result.projectedTotals.unisex}; {result.projectedTotals.missing} missing. Not saved yet.</p>}
    <div className="flex gap-3"><button disabled={busy} onClick={()=>void preview()} className="rounded border border-ld-border p-3">Refresh preview</button><button disabled={busy||!result||result.pendingProducts===0} onClick={()=>void apply()} className="rounded bg-ld-purple p-3 font-bold">{busy?'Applying…':'Apply / resume all labels'}</button>{busy&&<button onClick={()=>{stop.current=true;}}>Stop after current batch</button>}</div>
    {result&&<p className="text-xs text-ld-muted">Batch {result.version}</p>}
    {result&&<details><summary>Needs identity review: {result.blocked.length}</summary><ul>{result.blocked.map(p=><li key={p.id}>{p.product}: {p.reason}</li>)}</ul></details>}
  </main>;
}
