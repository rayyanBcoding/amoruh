// Latest full catalog regression: npx tsx scripts/test-catalog-refresh.ts
// Snapshot contains identities, notes and retail metadata only; accounting fields below are synthetic.
import assert from 'node:assert/strict';
import snapshot from './fixtures/catalog-refresh-2026-11-27.json';
import { coverageRows, coverageTotals, planRetailCoverage } from '../src/lib/retail-coverage';
import { retailReferenceError, retailIdentity, retailPriceView } from '../src/lib/retail-reference';
import type { Product } from '../src/lib/types';
const products=snapshot.map(p=>({...p,cost:12.34,retailPrice:987,lootPrice:40,minPrice:25,notes:'Synthetic protected sentinel'})) as unknown as Product[];
const before=JSON.stringify(products);
assert.equal(products.length,361);
assert.deepEqual(coverageTotals(products),{totalCatalogProducts:361,productsWithLiveNotes:309,verifiedRetail:32,estimatedRetail:283,manualRetail:0,missingRetailPrice:46,inStock:208});
const planned=planRetailCoverage(products,1000);
assert.deepEqual(planned.result.totals,{totalCatalogProducts:361,productsWithLiveNotes:359,verifiedRetail:34,estimatedRetail:327,manualRetail:0,missingRetailPrice:0,inStock:208});
assert.equal(planned.result.changedProducts,53);
assert.equal(planned.result.changedRetail,46);
assert.equal(planned.result.changedNotes,50);
assert.equal(planned.result.unresolvedNotes.length,2);
const strip=(p:Product)=>{const {liveNotes:_n,retailReference:_r,...rest}=p;void _n;void _r;return rest;};
for(let i=0;i<products.length;i++){
 const old=products[i],next=planned.products[i];
 assert.deepEqual(strip(next),strip(old),'every non-metadata field preserved');
 if(old.liveNotes?.keyNotes.length)assert.deepEqual(next.liveNotes,old.liveNotes,'existing notes and flags preserved');
 if(retailPriceView(old))assert.deepEqual(next.retailReference,old.retailReference,'all existing usable prices preserved, including estimates');
 assert.ok(retailPriceView(next),`${next.name}: usable retail`);
 const row=coverageRows.find(r=>r.productId===old.id)!;
 assert.ok(row);assert.equal(retailIdentity(row.identity),retailIdentity(old));
 assert.equal(retailReferenceError(row.retailReference,old.brand),null);
 if(!old.liveNotes && next.liveNotes){assert.ok(next.liveNotes.keyNotes.length);assert.ok(next.liveNotes.vibe);assert.ok(next.liveNotes.bestFor);assert.equal(next.liveNotes.check,true,'new drafts flagged for review');}
}
assert.equal(JSON.stringify(products),before,'planner does not mutate input');
let resumed=products,batches=0;
while(true){const step=planRetailCoverage(resumed,25);resumed=step.products;batches++;if(!step.result.pendingProducts)break;assert.ok(batches<10);}
assert.deepEqual(resumed,planned.products);assert.equal(batches,3);
assert.equal(planRetailCoverage(resumed).result.changedProducts,0);
const manual={...products.at(-1)!,retailReference:{...planned.products.at(-1)!.retailReference!,status:'manual' as const,priceCents:12345,manuallyEdited:true}};
assert.deepEqual(planRetailCoverage([manual]).products[0].retailReference,manual.retailReference);
const changed={...products.at(-1)!,sku:'Different identity'};
assert.equal(planRetailCoverage([changed]).result.missing.length,1);
console.log('Latest catalog:361 total;359 notes;2 unresolved;34 verified/327 estimated/0 manual/0 missing. 53 metadata-only updates across 3 resumable batches; all existing usable prices/notes and every protected field preserved.');
