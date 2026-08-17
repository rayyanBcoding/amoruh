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
    <span className={clsx("font-display font-bold tracking-[0.18em] text-ld-white", sizes[size])}>
      AMORUH
      <span className="ml-2 align-super text-[0.38em] font-semibold tracking-[0.25em] text-ld-purple">
        LIVE OS
      </span>
    </span>
  );

  if (!href) return content;
  return (
    <Link href={href} className="inline-flex items-center transition-opacity hover:opacity-70">
      {content}
    </Link>
  );
}
