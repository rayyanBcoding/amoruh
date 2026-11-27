// npx tsx scripts/test-catalog-gender.ts — no production writes.
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import snapshot from './fixtures/catalog-refresh-2026-11-27.json';
import seed from '../data/products.json';
import type { Product } from '../src/lib/types';
import { genderRows,genderTotals,planCatalogGender,CATALOG_GENDER_VERSION } from '../src/lib/catalog-gender';
import { isProductGender,productGenderLabel } from '../src/lib/product-gender';
import { retailIdentity } from '../src/lib/retail-reference';
import { validateProductInput } from '../src/lib/validation';
import { installFakeRedis } from './support/fake-redis';
const fake=installFakeRedis();
async function main(){
 const products=snapshot.map(p=>({...seed[0],...p,cost:12.34,retailPrice:999,inventory:p.inventory})) as Product[];
 assert.equal(genderRows.length,361);assert.equal(new Set(genderRows.map(r=>r.productId)).size,361);
 for(const r of genderRows){assert.ok(isProductGender(r.gender));assert.ok(r.basis);const p=products.find(p=>p.id===r.productId)!;assert.ok(p);assert.equal(retailIdentity(r.identity),retailIdentity(p));}
 const all=planCatalogGender(products,1000);
 assert.deepEqual(all.result.projectedTotals,{total:361,men:169,women:148,unisex:44,missing:0});
 assert.equal(all.result.changedProducts,361);assert.equal(all.result.blocked.length,0);
 const strip=(p:Product)=>{const{gender:_g,...rest}=p;void _g;return rest;};
 all.products.forEach((p,i)=>assert.deepEqual(strip(p),strip(products[i])));
 assert.equal(all.products.filter(p=>p.inventory===0&&!p.gender).length,0);
 const byCode=(code:string)=>all.products.find(p=>p.sku===code)!;
 assert.equal(byCode('8411061043882').gender,'men');assert.equal(byCode('8411061088289').gender,'women');
 assert.equal(byCode('614514177013').gender,'women');assert.equal(byCode('614514249031').gender,'women');
 assert.equal(byCode('085715321961').gender,'men');assert.equal(byCode('085715002334').gender,'unisex');
 assert.equal(byCode('3386460086349').gender,'men');assert.equal(byCode('652638013152').gender,'women');
 const manual={...products[0],gender:'women' as const};assert.equal(planCatalogGender([manual]).products[0].gender,'women');
 const renamed={...products[0],name:'Different flanker'};assert.deepEqual(planCatalogGender([renamed]).products,[renamed]);assert.equal(planCatalogGender([renamed]).result.blocked.length,1);
 const unknown={...products[0],id:'new-unreviewed'};assert.equal(planCatalogGender([unknown]).result.blocked.length,1);
 assert.deepEqual(['men','women','unisex',null].map(productGenderLabel),['Men','Women','Unisex','Not set']);
 for(const gender of ['men','women','unisex',null] as const)validateProductInput({gender},{existingProducts:[],isCreate:false});
 assert.throws(()=>validateProductInput({gender:'other' as Product['gender']},{existingProducts:[],isCreate:false}),/highlighted/);
 await fake.set('amoruh:products',products);await fake.set('amoruh:sale:sentinel',{cost:33,quantity:4});
 const {updateCatalogGender,updateCatalogMetadata}=await import('../src/lib/product-metadata-db');
 await assert.rejects(updateCatalogGender(current=>({products:current.map((p,i)=>i===0?{...p,cost:999}:p),result:null})),/other product/);
 await assert.rejects(updateCatalogMetadata(current=>({products:current.map((p,i)=>i===0?{...p,gender:'men'}:p),result:null})),/product data/);
 const original=fake.eval.bind(fake);let raced=false;
 fake.eval=async(...args:Parameters<typeof fake.eval>)=>{if(!raced){raced=true;await fake.set('amoruh:products',products.map((p,i)=>i===0?{...p,inventory:77,cost:777}:p));}return original(...args);};
 await updateCatalogGender(current=>planCatalogGender(current,25));
 assert.equal((await fake.get<Product[]>('amoruh:products'))![0].inventory,77);assert.equal((await fake.get<Product[]>('amoruh:products'))![0].cost,777);
 process.env.SITE_PASSCODE='test';process.env.AUTH_COOKIE_SECRET='test-secret';
 const {computeAuthToken}=await import('../src/lib/auth');const{GET,POST}=await import('../src/app/api/internal/catalog-gender/route');
 const address='http://localhost/api/internal/catalog-gender',cookie=`amoruh_auth=${await computeAuthToken()}`;
 const req=(body:unknown,origin='http://localhost')=>new NextRequest(address,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await GET(new NextRequest(address))).status,401);assert.equal((await POST(new NextRequest(address,{method:'POST'}))).status,401);
 assert.equal((await POST(req({version:CATALOG_GENDER_VERSION},'https://evil.test'))).status,403);
 assert.equal((await POST(req({version:'old'}))).status,409);assert.equal((await POST(req({version:CATALOG_GENDER_VERSION,limit:1000}))).status,400);
 const version=await fake.get('amoruh:version');assert.equal((await GET(new NextRequest(address,{headers:{cookie}}))).status,200);assert.equal(await fake.get('amoruh:version'),version);
 for(let i=0;i<20;i++){const r=await POST(req({version:CATALOG_GENDER_VERSION,limit:25}));assert.equal(r.status,200);const data=await r.json();if(!data.pendingProducts){assert.equal(data.totals.missing,0);break;}assert.ok(i<19);}
 const saved=await fake.get<Product[]>('amoruh:products');assert.equal(genderTotals(saved!).missing,0);
 const endVersion=await fake.get('amoruh:version');await POST(req({version:CATALOG_GENDER_VERSION}));assert.equal(await fake.get('amoruh:version'),endVersion);
 assert.deepEqual(await fake.get('amoruh:sale:sentinel'),{cost:33,quantity:4});
 const {createProduct,updateProduct}=await import('../src/lib/db');const p=await createProduct({sku:'new-gender-test',brand:'Test',name:'Test',gender:'unisex'});assert.equal(p.gender,'unisex');assert.equal((await updateProduct(p.id,{gender:'men'}))?.gender,'men');
 console.log('Gender:361 exact identities;169 Men/148 Women/44 Unisex/0 missing. Protected fields/manual labels, sold-out scope, variant barcodes, input validation, create/edit persistence, CAS race, auth/origin/version, preview and resumable no-op apply passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
