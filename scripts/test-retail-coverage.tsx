// Hermetic entire-catalog policy/apply tests. No production credentials/data writes.
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { installFakeRedis } from "./support/fake-redis";
import fixture from "./fixtures/retail-coverage-status.json";
import prior from "../src/lib/data/intake-live-enrichment.json";
import catalog from "../src/lib/data/catalog-live-enrichment.json";
import seed from "../data/products.json";
import type { Product } from "../src/lib/types";
import { coverageRows as entireCoverageRows, coverageTotals, planRetailCoverage, RETAIL_COVERAGE_VERSION } from "../src/lib/retail-coverage";
import { retailIdentity, retailPriceView, retailReferenceError, type RetailReference } from "../src/lib/retail-reference";
import { RetailReferenceLine } from "../src/components/RetailReferenceLine";

const coverageRows=entireCoverageRows.slice(0,315);
const fake=installFakeRedis();
async function main(){
  assert.equal(coverageRows.length,315);
  assert.equal(new Set(coverageRows.map(r=>r.productId)).size,315);
  const existingNotes=new Set(fixture.existingLiveNotesIds),fallback=new Set(fixture.fallbackNotesIds),inStock=new Set(fixture.inStockIds);
  const priorVerified=new Map([...prior,...catalog].filter(r=>r.retailReference.status==="verified"&&r.productId!=="p_1795143897384_n8edi8").map(r=>[r.productId,r.retailReference as RetailReference]));
  const manual=new Map([
    ["p_1793928518539_zwklf6",[16200,"200 mL","https://www.jeanpaulgaultier.com/us/en_US/p/range-le-male/ultra-male-eau-de-toilette-intense-000000000065127311"]],
    ["p_1793929775824_sirhzv",[11200,"100 mL","https://us.burberry.com/burberry-weekend-eau-de-toilette-100ml-p34547091"]],
    ["p_1795142506810_ububu5",[13000,"75 mL","https://www.gucci.com/us/en/pr/beauty/fragrances/fragrances-for-women/gucci-bamboo-75ml-eau-de-toilette-p-A001U2999990099"]],
  ] as const);
  const products=coverageRows.map<Product>(row=>{
    const p={...seed[0],...row.identity,id:row.productId,inventory:inStock.has(row.productId)?1:0,cost:42.75,retailPrice:9999,
      topNotes:[],middleNotes:[],baseNotes:[],fragranceNotes:[],sellingKeyNotes:fallback.has(row.productId)?["Existing fallback"]:[],
      liveNotes:existingNotes.has(row.productId)?{keyNotes:["Preserve exactly"],vibe:"Existing",bestFor:"Existing",source:"manual" as const,check:true,updatedAt:"2026-01-01"}:undefined,
      retailReference:priorVerified.get(row.productId),
    } as Product;
    const m=manual.get(row.productId as never);
    if(m)p.retailReference={status:"verified",priceCents:m[0],referenceSize:m[1],retailer:"Official brand website",sourceUrl:m[2],currency:"USD",concentration:p.concentration,checkedAt:"2026-11-21",identityKey:retailIdentity(p),manuallyEdited:true,verificationNotes:"Existing operator value"};
    if(row.productId==="p_1793930267060_xrj6a6")p.retailReference={status:"not_verified",priceCents:null,referenceSize:null,retailer:null,sourceUrl:null,currency:"USD",concentration:p.concentration,checkedAt:"2026-11-20",identityKey:retailIdentity(p),manuallyEdited:true,verificationNotes:"Marked not verified by operator."};
    return p;
  });
  for(const row of coverageRows){
    assert.equal(retailReferenceError(row.retailReference,row.identity.brand),null,`${row.identity.name}: valid recipe`);
    assert.equal(row.retailReference.identityKey,retailIdentity(row.identity));
  }
  assert.deepEqual(coverageTotals(products),{totalCatalogProducts:315,productsWithLiveNotes:212,verifiedRetail:27,estimatedRetail:0,manualRetail:0,missingRetailPrice:288,inStock:144});
  const all=planRetailCoverage(products,Infinity);
  assert.deepEqual(all.result.totals,{totalCatalogProducts:315,productsWithLiveNotes:313,verifiedRetail:32,estimatedRetail:283,manualRetail:0,missingRetailPrice:0,inStock:144});
  assert.equal(all.result.missing.length,0);
  assert.equal(all.result.unresolvedNotes.length,2);
  assert.equal(all.products.find(p=>p.id==="p_1793930267060_xrj6a6")?.retailReference?.status,"estimated");
  const protectedFields=(p:Product)=>{const{liveNotes:_n,retailReference:_r,...rest}=p;void _n;void _r;return rest;};
  for(const [i,p] of products.entries()){
    assert.deepEqual(protectedFields(all.products[i]),protectedFields(p));
    if(p.liveNotes)assert.deepEqual(all.products[i].liveNotes,p.liveNotes);
    if((p.retailReference?.priceCents??0)>0)assert.deepEqual(all.products[i].retailReference,p.retailReference);
    assert.ok(retailPriceView(all.products[i]));
  }
  assert.equal(all.products.filter(p=>p.inventory===0&&retailPriceView(p)).length,171);
  let resumed=products;let batches=0;
  for(;;){const step=planRetailCoverage(resumed,25);assert.ok(step.result.changedProducts<=25);resumed=step.products;batches++;if(!step.result.pendingProducts)break;assert.ok(batches<20);}
  assert.deepEqual(resumed,all.products);
  assert.equal(planRetailCoverage(resumed).result.changedProducts,0);
  const wrong={...products[0],name:"Different concentration/flanker"};
  assert.equal(planRetailCoverage([wrong]).result.missing.length,1);
  assert.deepEqual(planRetailCoverage([wrong]).products,[wrong]);
  const changedManual={...products[1],retailReference:{...all.products[1].retailReference!,status:"manual" as const,priceCents:7777,retailer:null,sourceUrl:null,manuallyEdited:true}};
  assert.deepEqual(planRetailCoverage([changedManual]).products[0].retailReference,changedManual.retailReference);
  const estimated={...all.products[1],retailReference:{...all.products[1].retailReference!,status:"estimated" as const}};
  const html=(p:Product)=>renderToStaticMarkup(createElement(RetailReferenceLine,{product:p}));
  assert.match(html(estimated),/Retail: ~\$/);
  assert.doesNotMatch(html(changedManual),/Retail: ~/);
  assert.match(html(changedManual),/Retail: \$77.77/);
  assert.doesNotMatch(html(changedManual),/Not verified|9,999/);
  const stale=all.products.find(p=>p.retailReference?.status==="verified"&&!p.retailReference.manuallyEdited)!;
  assert.equal(retailPriceView(stale,Date.parse("2027-01-01"))?.status,"estimated");
  const pending={...estimated,retailReference:undefined};
  assert.match(html(pending),/Retail: Pending/);
  assert.doesNotMatch(html(pending),/9,999/);
  for(const status of ["manual","estimated"] as const){
    assert.equal(retailReferenceError({...estimated.retailReference,status,retailer:null,sourceUrl:null},estimated.brand),null);
  }
  assert.notEqual(retailReferenceError({...estimated.retailReference,status:"estimated",verificationNotes:""},estimated.brand),null);
  assert.notEqual(retailReferenceError({...estimated.retailReference,status:"verified",retailer:null,sourceUrl:null},estimated.brand),null);
  assert.notEqual(retailReferenceError({...estimated.retailReference,status:"estimated",retailer:"Nordstrom",sourceUrl:"https://fragrancenet.com/"},estimated.brand),null);

  await fake.set("amoruh:products",products);
  await fake.set("amoruh:sale:sentinel",{price:99,landedCostAtSale:42.75});
  const {updateCatalogMetadata}=await import("../src/lib/product-metadata-db");
  const evalOriginal=fake.eval.bind(fake);let raced=false;
  fake.eval=async(...args:Parameters<typeof fake.eval>)=>{if(!raced){raced=true;await fake.set("amoruh:products",products.map((p,i)=>i===0?{...p,inventory:77,cost:777}:p));}return evalOriginal(...args);};
  await updateCatalogMetadata(current=>planRetailCoverage(current,25));
  const saved=await fake.get("amoruh:products") as Product[];
  assert.equal(saved[0].inventory,77);assert.equal(saved[0].cost,777);assert.equal(saved[0].retailPrice,9999);
  assert.deepEqual(await fake.get("amoruh:sale:sentinel"),{price:99,landedCostAtSale:42.75});
  process.env.SITE_PASSCODE="test";process.env.AUTH_COOKIE_SECRET="test-secret";
  const {computeAuthToken}=await import("../src/lib/auth");
  const {GET,POST}=await import("../src/app/api/internal/catalog-retail-coverage/route");
  const address="http://localhost/api/internal/catalog-retail-coverage";
  assert.equal((await GET(new NextRequest(address))).status,401);
  assert.equal((await POST(new NextRequest(address,{method:"POST"}))).status,401);
  const cookie=`amoruh_auth=${await computeAuthToken()}`;
  const request=(body:unknown,origin="http://localhost")=>new NextRequest(address,{method:"POST",headers:{cookie,origin,"content-type":"application/json"},body:JSON.stringify(body)});
  assert.equal((await POST(request({version:RETAIL_COVERAGE_VERSION},"https://evil.test"))).status,403);
  assert.equal((await POST(request({version:"stale"}))).status,409);
  assert.equal((await POST(request({version:RETAIL_COVERAGE_VERSION,limit:1000}))).status,400);
  const version=await fake.get("amoruh:version");
  assert.equal((await GET(new NextRequest(address,{headers:{cookie}}))).status,200);
  assert.equal(await fake.get("amoruh:version"),version); // preview is read-only
  for(let i=0;i<20;i++){const response=await POST(request({version:RETAIL_COVERAGE_VERSION,limit:25}));assert.equal(response.status,200);const body=await response.json();if(body.pendingProducts===0){assert.equal(body.totals.missingRetailPrice,0);break;}assert.ok(i<19);}
  const completeVersion=await fake.get("amoruh:version");
  await POST(request({version:RETAIL_COVERAGE_VERSION,limit:25}));
  assert.equal(await fake.get("amoruh:version"),completeVersion);
  console.log(`Coverage:315 total;313 with notes;32 verified/283 estimated/0 explicit-manual/0 missing. Legacy operator-edited verified prices preserved. ${batches} resumable fixture batches; sold-out scope, manual/notes preservation, display statuses, stale evidence, auth, version guards, CAS inventory race and no-op replay passed.`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
