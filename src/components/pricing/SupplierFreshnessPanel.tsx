interface FreshnessEntry {
  supplierId: string;
  supplierName: string;
  filename: string | null;
  completedAt: string | null;
  daysSinceLastCommit: number | null;
  status: "current" | "stale" | "never";
}

/** Compact supplier price-list freshness section — replaces the large
 *  Recent Uploads panel on the main dashboard. Shows each supplier's
 *  most recent SUCCESSFULLY COMMITTED (never a failed/superseded)
 *  generation. Full upload history stays on the existing per-supplier
 *  page, unchanged. */
export function SupplierFreshnessPanel({ freshness }: { freshness: FreshnessEntry[] }) {
  return (
    <div className="glass-panel rounded-2xl p-5">
      <p className="mb-3 text-[11px] font-bold uppercase tracking-widest text-ld-muted">Supplier Price-List Freshness</p>
      <div className="space-y-1.5">
        {freshness.map((f) => (
          <div key={f.supplierId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-ld-bg-elevated px-3 py-2 text-sm">
            <span className="font-medium text-ld-white">{f.supplierName}</span>
            <span className="flex items-center gap-2 text-xs text-ld-muted">
              {f.status === "never" ? (
                <span className="font-bold uppercase tracking-wide text-ld-red">No committed price list yet</span>
              ) : (
                <>
                  <span className="truncate">{f.filename}</span>
                  <span>{f.completedAt ? new Date(f.completedAt).toLocaleString() : ""}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${
                      f.status === "current" ? "bg-ld-green/15 text-ld-green" : "bg-ld-amber/15 text-ld-amber"
                    }`}
                  >
                    {f.status === "current" ? "Current" : `Requires Attention · ${f.daysSinceLastCommit}d`}
                  </span>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
