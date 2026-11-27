// npx tsx scripts/test-inventory-gender-ui.tsx
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import seed from '../data/products.json';
import type { Product } from '../src/lib/types';
async function main(){
 const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'http://localhost/inventory'});
 Object.assign(globalThis,{window:dom.window,self:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,IS_REACT_ACT_ENVIRONMENT:true});
 const requests:string[]=[];
 globalThis.fetch=async(input)=>{requests.push(String(input));return new Response('{}',{headers:{'content-type':'application/json'}});};
 const {createElement,act}=await import('react');const{createRoot}=await import('react-dom/client');
 const{AppRouterContext}=await import('next/dist/shared/lib/app-router-context.shared-runtime');
 const{InventoryTable}=await import('../src/components/inventory/InventoryTable');
 const router={bfcacheId:'test',push(){},replace(){},refresh(){},back(){},forward(){},prefetch(){}};
 const products=['men','women','unisex',undefined].map((gender,i)=>({...seed[0],id:String(i),brand:'Test',name:`Product ${i}`,image:'',gender,inventory:4,status:'active'})) as Product[];
 const root=createRoot(document.getElementById('root')!);
 await act(async()=>root.render(createElement(AppRouterContext.Provider,{value:router},createElement(InventoryTable,{products}))));
 assert.equal(document.querySelectorAll('tbody tr').length,4);
 const text=document.querySelector('tbody')!.textContent!;
 for(const label of ['Men','Women','Unisex','Not set'])assert.ok(text.includes(label));
 const select=document.querySelector('select[aria-label="Filter by marketed audience"]') as HTMLSelectElement;
 for(const [value,id] of [['men','0'],['women','1'],['unisex','2'],['missing','3']]){
  await act(async()=>{select.value=value;select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  assert.equal(document.querySelectorAll('tbody tr').length,1);
  assert.ok(document.querySelector('tbody')!.textContent!.includes(`Product ${id}`));
 }
 await act(async()=>{select.value='all';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 assert.equal(document.querySelectorAll('tbody tr').length,4);
 assert.deepEqual(products.map(p=>p.inventory),[4,4,4,4]);
 assert.deepEqual(requests.sort(),['/api/intake/landed-costs','/api/intake/sales-summary'],'filter only reads existing summaries; no writes');
 await act(async()=>root.unmount());dom.window.close();
 console.log('Inventory gender UI: labels, exact Men/Women/Unisex/Not set filters, reset and no inventory writes passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
