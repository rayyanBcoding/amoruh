import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { getProducts } from "@/lib/db";
import { updateCatalogGender } from "@/lib/product-metadata-db";
import { planCatalogGender, CATALOG_GENDER_VERSION } from "@/lib/catalog-gender";
import { broadcastStateChanged } from "@/lib/events";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"private, no-store",vary:"Cookie"};
const authorized=(req:NextRequest)=>verifyAuthToken(req.cookies.get(AUTH_COOKIE_NAME)?.value);
export async function GET(req:NextRequest) {
  if(!await authorized(req)) return NextResponse.json({error:"Not authorized."},{status:401,headers});
  try {
    const plan=planCatalogGender(await getProducts(),0);
    return NextResponse.json({mode:"preview",...plan.result},{headers});
  } catch { return NextResponse.json({error:"Could not preview catalog gender labels."},{status:500,headers}); }
}
export async function POST(req:NextRequest) {
  if(!await authorized(req)) return NextResponse.json({error:"Not authorized."},{status:401,headers});
  if(req.headers.get("origin")!==req.nextUrl.origin) return NextResponse.json({error:"Same-origin request required."},{status:403,headers});
  try {
    const body=await req.json();
    if(body.version!==CATALOG_GENDER_VERSION) return NextResponse.json({error:"Batch changed; refresh the preview."},{status:409,headers});
    const limit=body.limit ?? 25;
    if(!Number.isInteger(limit)||limit<1||limit>50) return NextResponse.json({error:"Batch size must be 1–50."},{status:400,headers});
    const result=await updateCatalogGender((current)=>planCatalogGender(current,limit));
    if(result.changedProducts) broadcastStateChanged("catalog-gender");
    return NextResponse.json({mode:"applied",...result},{headers});
  } catch { return NextResponse.json({error:"Catalog changed or a recipe is invalid. Refresh and resume; completed batches are preserved."},{status:409,headers}); }
}
