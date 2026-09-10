"use client";

import Link from "next/link";
import { timeAgo } from "@/lib/format";
import type { ActivityItem } from "@/lib/dashboard-db";

/** Only ever real, already-timestamped events from Go Live/Inventory
 *  Intake/Pricing-Ordering — see getRecentActivity in dashboard-db.ts.
 *  Never a fabricated row. */
export function RecentActivityFeed({ items }: { items: ActivityItem[] }) {
  return (
    <div className="glass-panel rounded-2xl p-5">
      <h3 className="mb-3 font-display text-sm font-bold uppercase tracking-widest text-ld-muted">Recent Activity</h3>
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-ld-border p-6 text-center text-sm text-ld-muted">Nothing yet.</p>
      ) : (
        <div className="max-h-96 space-y-1 overflow-y-auto pr-1">
          {items.map((item, i) => {
            const content = (
              <div className="flex items-start justify-between gap-3 rounded-lg px-2 py-2 text-sm hover:bg-ld-bg-elevated">
                <span className="text-ld-white">{item.text}</span>
                <span className="shrink-0 text-xs text-ld-muted">{timeAgo(item.timestamp)}</span>
              </div>
            );
            return item.href ? (
              <Link key={`${item.timestamp}-${i}`} href={item.href}>
                {content}
              </Link>
            ) : (
              <div key={`${item.timestamp}-${i}`}>{content}</div>
            );
          })}
        </div>
      )}
    </div>
  );
}
