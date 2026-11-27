import batch from "./data/product-gender.json";
import type { Product } from "./types";
import { isProductGender, type ProductGender } from "./product-gender";
import { retailIdentity, type RetailIdentity } from "./retail-reference";

export const CATALOG_GENDER_VERSION = "2026-11-27-v1";
export interface GenderRow { productId:string; identity:RetailIdentity; gender:ProductGender; basis:string; }
export const genderRows = batch as GenderRow[];
export function genderTotals(products: readonly Product[]) {
  const totals={total:products.length,men:0,women:0,unisex:0,missing:0};
  for(const p of products){if(isProductGender(p.gender))totals[p.gender]++;else totals.missing++;}
  return totals;
}
/** Exact reviewed identities, every stock/status; existing operator categories win. */
export function planCatalogGender(current:Product[],limit=25,rows:readonly GenderRow[]=genderRows){
  const byId=new Map(rows.map(r=>[r.productId,r]));
  const blocked:{id:string;product:string;reason:string}[]=[];
  const proposals=new Map<string,Product>();
  for(const p of current){
    if(isProductGender(p.gender))continue;
    const row=byId.get(p.id);
    if(!row||retailIdentity(row.identity)!==retailIdentity(p)){
      blocked.push({id:p.id,product:`${p.brand} ${p.name}`,reason:"New or changed identity needs review; no audience guessed."});continue;
    }
    if(!isProductGender(row.gender))throw Error(`Invalid gender recipe: ${p.id}`);
    proposals.set(p.id,{...p,gender:row.gender});
  }
  const selected=new Set([...proposals.keys()].slice(0,Math.max(0,limit)));
  const products=current.map(p=>selected.has(p.id)?proposals.get(p.id)!:p);
  return {products,result:{version:CATALOG_GENDER_VERSION,currentTotals:genderTotals(current),totals:genderTotals(products),projectedTotals:genderTotals(current.map(p=>proposals.get(p.id)??p)),changedProducts:selected.size,pendingProducts:proposals.size-selected.size,blocked}};
}
