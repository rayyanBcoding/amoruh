import clsx from "clsx";

export function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-ld-border bg-ld-bg-elevated px-3 py-1.5 text-xs font-medium">
      <span className="relative flex h-2 w-2">
        {connected && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ld-green opacity-75" />
        )}
        <span
          className={clsx(
            "relative inline-flex h-2 w-2 rounded-full",
            connected ? "bg-ld-green" : "bg-ld-red"
          )}
        />
      </span>
      <span className={connected ? "text-ld-muted" : "text-ld-red"}>
        {connected ? "Live sync connected" : "Reconnecting…"}
      </span>
    </div>
  );
}
