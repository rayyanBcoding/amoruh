// Sanitized view of a raw TikTok response, for inspecting REAL field names and
// shapes without ever exposing buyer data.
//
// Two layers:
//   1. DENY first: any key that looks like buyer / recipient / contact / address
//      data has its entire subtree replaced by "<redacted>" — nothing inside it is
//      shown, not even nested key names.
//   2. ALLOW second: every other scalar is shown ONLY if its key is on the
//      allow-list below (the Phase 2 fields we agreed to preserve, plus pure
//      order/money/status fields). All remaining scalars show as
//      "<hidden:type>", so we learn the field exists and its type without seeing
//      the value. Unknown fields therefore fail CLOSED.
//
// Large numeric IDs are already strings (json.ts); numbers are shown as-is only
// for allow-listed keys.

const DENY_KEY = /(buyer|recipient|address|phone|email|postal|zip|first_name|last_name|full_name|district|street|user_id|nickname|message|note|remark|id_number|passport|card|payment_method|ip_address|cipher|token|secret|signature)/i;

export const ALLOW_KEYS: ReadonlySet<string> = new Set([
  // identity / ids (kept as strings)
  "id", "order_id", "order_line_id", "line_item_id", "product_id", "sku_id", "seller_sku", "package_id", "package_ids",
  "room_id", "auto_combine_group_id", "shop_id", "request_id", "code",
  // classification / status
  "status", "display_status", "order_type", "fulfillment_type", "delivery_option_type", "delivery_option_name", "shipping_type",
  "shipping_provider", "shipping_provider_id", "is_sample_order", "is_cod", "is_on_hold_order", "split_or_combine_tag",
  "cancel_reason", "cancellation_initiator", "payment_method_name", "collection_due_time", "sku_type", "is_gift",
  // timestamps
  "create_time", "update_time", "paid_time", "rts_time", "tts_sla_time", "delivery_time", "collection_time", "cancel_time",
  "delivery_due_time", "shipping_due_time", "rts_sla_time",
  // product / quantity / money
  "product_name", "sku_name", "quantity", "currency", "sale_price", "original_price", "platform_discount", "seller_discount",
  "total_amount", "sub_total", "shipping_fee", "original_shipping_fee", "shipping_fee_platform_discount",
  "shipping_fee_seller_discount", "tax", "retail_delivery_fee", "small_order_fee", "original_total_product_price",
  "payment", "tracking_number", "total_count", "next_page_token",
]);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const MAX_ARRAY_ITEMS = 2;

function hidden(v: unknown): string {
  if (v === null) return "<hidden:null>";
  return `<hidden:${typeof v}>`;
}

export function sanitize(value: unknown, key = ""): Json {
  if (key && DENY_KEY.test(key)) return "<redacted>";
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const shown = value.slice(0, MAX_ARRAY_ITEMS).map((v) => sanitize(v, key));
    return { _array_length: value.length, _shown: shown } as Json;
  }
  if (typeof value === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitize(v, k);
    return out;
  }
  if (ALLOW_KEYS.has(key)) return value as Json;
  return hidden(value);
}

/** Every key path (arrays flattened as `[]`) with its value type — the "shape" of a response. */
export function keyPaths(value: unknown, prefix = "", acc: Set<string> = new Set()): string[] {
  if (Array.isArray(value)) {
    for (const v of value) keyPaths(v, `${prefix}[]`, acc);
    if (value.length === 0) acc.add(`${prefix}[]`);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (DENY_KEY.test(k)) acc.add(`${p}  <redacted subtree>`);
      else keyPaths(v, p, acc);
    }
  } else {
    acc.add(`${prefix}: ${value === null ? "null" : typeof value}`);
  }
  return [...acc].sort();
}
