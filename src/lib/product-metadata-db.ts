import { redis, KEYS } from "./kv";
import { getProducts } from "./db";
import type { Product } from "./types";

// Compare the ENTIRE catalog at commit so notes/reference writes cannot replace
// a concurrent stock edit. Supply JS-serialized JSON to SET (Lua cjson would
// turn existing empty arrays into objects). No sale/intake records are touched.
export const METADATA_CAS = `
local function equal(a,b)
 if type(a) ~= type(b) then return false end
 if type(a) ~= 'table' then return a == b end
 for k,v in pairs(a) do if not equal(v,b[k]) then return false end end
 for k,v in pairs(b) do if a[k] == nil then return false end end
 return true
end
local raw = redis.call('GET', KEYS[1])
local current = raw and cjson.decode(raw) or {}
if not equal(current,cjson.decode(ARGV[1])) then return 'CONFLICT' end
redis.call('SET',KEYS[1],ARGV[2])
redis.call('INCR',KEYS[2])
return 'OK'
`;
export async function updateCatalogMetadata<T>(plan: (current: Product[]) => { products: Product[]; result: T }): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await getProducts();
    const { products, result } = plan(current);
    // Assert every field other than the two authorized metadata fields stays identical.
    const strip = (p: Product) => { const { liveNotes: _n, retailReference: _r, ...rest } = p; void _n; void _r; return JSON.stringify(rest); };
    if (current.length !== products.length || current.some((p, i) => strip(p) !== strip(products[i]))) throw new Error("Metadata update attempted to change product data.");
    if (JSON.stringify(current) === JSON.stringify(products)) return result;
    if (await redis.eval(METADATA_CAS, [KEYS.products, KEYS.version], [JSON.stringify(current), JSON.stringify(products)]) === "OK") return result;
  }
  throw new Error("Catalog changed during update; retry safely.");
}

/** Separate, narrow writer: a gender batch cannot modify notes, prices or stock. */
export async function updateCatalogGender<T>(plan: (current: Product[]) => { products: Product[]; result: T }): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await getProducts();
    const { products, result } = plan(current);
    const strip = (p: Product) => { const { gender: _gender, ...rest } = p; void _gender; return JSON.stringify(rest); };
    if (current.length !== products.length || current.some((p, i) => strip(p) !== strip(products[i]))) throw new Error("Gender update attempted to change other product data.");
    if (JSON.stringify(current) === JSON.stringify(products)) return result;
    if (await redis.eval(METADATA_CAS, [KEYS.products, KEYS.version], [JSON.stringify(current), JSON.stringify(products)]) === "OK") return result;
  }
  throw new Error("Catalog changed during update; retry safely.");
}
