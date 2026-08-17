import clsx from "clsx";

interface NotesPyramidProps {
  topNotes: string[];
  middleNotes: string[];
  baseNotes: string[];
  size?: "md" | "lg";
}

const TIERS: { key: "topNotes" | "middleNotes" | "baseNotes"; label: string; dot: string }[] = [
  { key: "topNotes", label: "Top", dot: "bg-ld-cyan" },
  { key: "middleNotes", label: "Middle", dot: "bg-ld-purple" },
  { key: "baseNotes", label: "Base", dot: "bg-ld-amber" },
];

export function NotesPyramid({ topNotes, middleNotes, baseNotes, size = "md" }: NotesPyramidProps) {
  const data = { topNotes, middleNotes, baseNotes };
  return (
    <div className="space-y-2.5">
      {TIERS.map((tier) => (
        <div key={tier.key} className="flex items-start gap-3">
          <span className={clsx("mt-1.5 h-2 w-2 shrink-0 rounded-full", tier.dot)} />
          <div>
            <p
              className={clsx(
                "font-bold uppercase tracking-widest text-ld-muted",
                size === "lg" ? "text-sm" : "text-[11px]"
              )}
            >
              {tier.label} Notes
            </p>
            <p className={clsx("font-medium text-ld-white", size === "lg" ? "text-lg" : "text-sm")}>
              {data[tier.key].join(", ") || "—"}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
