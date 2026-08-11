import Link from "next/link";
import clsx from "clsx";

export function Logo({
  size = "md",
  href = "/dashboard",
}: {
  size?: "sm" | "md" | "lg";
  href?: string | null;
}) {
  const sizes = {
    sm: "text-lg",
    md: "text-2xl",
    lg: "text-5xl",
  } as const;

  const content = (
    <span className={clsx("font-display font-extrabold tracking-tight", sizes[size])}>
      <span className="text-gradient-brand">LOOT</span>{" "}
      <span className="text-white">DEPOT</span>
      <span className="ml-1.5 align-super text-[0.4em] font-bold tracking-widest text-ld-cyan">
        OS
      </span>
    </span>
  );

  if (!href) return content;
  return (
    <Link href={href} className="inline-flex items-center transition-opacity hover:opacity-80">
      {content}
    </Link>
  );
}
