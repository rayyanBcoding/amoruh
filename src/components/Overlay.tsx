// Shared modal shell — extracted from the Receiving screen so
// CreateProductModal (and anything else) can reuse the same overlay
// look instead of duplicating it.
export function Overlay({
  children,
  size = "md",
}: {
  children: React.ReactNode;
  size?: "md" | "lg" | "xl";
}) {
  const maxWidth = { md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" }[size];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className={`glass-panel max-h-[90vh] w-full ${maxWidth} overflow-y-auto rounded-2xl p-6`}>{children}</div>
    </div>
  );
}
