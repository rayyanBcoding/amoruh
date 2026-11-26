import type { Product } from "./types";

export type PickerProduct = Pick<Product, "id" | "brand" | "name" | "concentration" | "size" | "condition" | "inventory" | "sku" | "barcode">;
const normalize = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/\s+/g, " ");

/** Build once per catalog update; searching never calls a receiving endpoint. */
export function indexIntakeProducts(products: readonly PickerProduct[]) {
  return products.map((product, order) => {
    const brand = normalize(product.brand), productName = normalize(product.name);
    const name = `${brand} ${productName}`.trim();
    const sku = normalize(product.sku || ""), barcode = normalize(product.barcode || "");
    return { product, order, name, brand, productName, sku, barcode, text: `${name} ${sku} ${barcode} ${normalize(`${product.concentration} ${product.size} ${product.condition}`)}` };
  });
}
export function searchIntakeProducts(index: ReturnType<typeof indexIntakeProducts>, query: string) {
  const q = normalize(query), tokens = q.split(" ").filter(Boolean);
  return index.flatMap((row) => {
    if (!tokens.every((token) => row.text.includes(token))) return [];
    const words = row.name.split(/\s+/);
    const score = !q ? 0 : q === row.sku || q === row.barcode ? 10000
      : row.name === q || row.productName === q ? 9000 : row.brand === q ? 8800
      : row.name.startsWith(q) ? 8500 : row.productName.startsWith(q) ? 8000
      : row.name.includes(q) ? 7000
      : tokens.every((token) => words.some((word) => word.startsWith(token))) ? 6000
      : tokens.every((token) => row.name.includes(token)) ? 5000 : 1000;
    return [{ ...row, score }];
  }).sort((a, b) => b.score - a.score || a.order - b.order).map((row) => row.product);
}
