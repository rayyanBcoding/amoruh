/** Fragrance merchandising audience, not a restriction on who can wear it. */
export type ProductGender = "men" | "women" | "unisex";
export const PRODUCT_GENDER_LABELS: Record<ProductGender, string> = { men: "Men", women: "Women", unisex: "Unisex" };
export function isProductGender(value: unknown): value is ProductGender {
  return value === "men" || value === "women" || value === "unisex";
}
export function productGenderLabel(value: unknown): string {
  return isProductGender(value) ? PRODUCT_GENDER_LABELS[value] : "Not set";
}
