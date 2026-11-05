import { callOpenApi, type ClientDeps } from "./client";
import { TIKTOK_API } from "./config";
import type { StoredShop } from "./store";

// GET /authorization/202309/shops — scope seller.authorization.info. Read-only.
// Field names follow the 202309 reference (id, name, region, seller_type, cipher,
// code); parsing is defensive and IDs stay strings.

interface RawShop {
  id?: string | number;
  name?: string;
  region?: string;
  seller_type?: string;
  cipher?: string;
  code?: string;
}

export async function getAuthorizedShops(accessToken: string, deps: ClientDeps = {}): Promise<{ shops: StoredShop[]; requestId: string | null }> {
  const { data, requestId } = await callOpenApi<{ shops?: RawShop[] }>({ method: "GET", path: TIKTOK_API.authorizedShopsPath, accessToken }, deps);
  const shops = (data.shops ?? []).map(
    (s): StoredShop => ({
      id: String(s.id ?? ""),
      name: s.name ?? "",
      region: s.region ?? "",
      sellerType: s.seller_type ?? "",
      cipher: s.cipher ?? "",
      code: s.code ?? "",
    })
  );
  return { shops, requestId };
}
