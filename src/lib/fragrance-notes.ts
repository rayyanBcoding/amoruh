import type { Product } from "./types";

// ---------------------------------------------------------------------
// Unified fragrance-notes view. `fragranceNotes` is the real field going
// forward (set by the Product Editor's single "Fragrance Notes" field);
// `topNotes`/`middleNotes`/`baseNotes` stay in the type untouched for
// backward compatibility with data that hasn't been edited under the new
// system yet — this is the fallback for exactly that case, used for
// display only. It never writes back to the old fields.
// ---------------------------------------------------------------------

export function getFragranceNotes(
  p: Pick<Product, "fragranceNotes" | "topNotes" | "middleNotes" | "baseNotes">
): string[] {
  if (p.fragranceNotes && p.fragranceNotes.length > 0) return p.fragranceNotes;
  return [...p.topNotes, ...p.middleNotes, ...p.baseNotes];
}
