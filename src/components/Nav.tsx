"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { Logo } from "./Logo";
import { useLiveState } from "@/context/LiveStateContext";
import { ConnectionDot } from "./ConnectionDot";

const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/inventory", label: "Inventory" },
];

export function Nav() {
  const pathname = usePathname();
  const { connected } = useLiveState();

  return (
    <header className="sticky top-0 z-40 border-b border-ld-border bg-ld-bg">
      <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4 px-6 py-3.5">
        <Logo size="sm" href="/dashboard" />

        <nav className="flex items-center gap-1">
          {LINKS.map((link) => {
            const active = pathname?.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={clsx(
                  "rounded-lg px-4 py-2 text-sm font-semibold transition-colors",
                  active
                    ? "bg-ld-purple/15 text-ld-white ring-1 ring-inset ring-ld-purple/40"
                    : "text-ld-muted hover:bg-ld-bg-elevated hover:text-ld-white"
                )}
              >
                {link.label}
              </Link>
            );
          })}
          <Link
            href="/tv"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1 rounded-lg border border-ld-cyan/30 bg-ld-cyan/5 px-4 py-2 text-sm font-semibold text-ld-cyan transition-colors hover:bg-ld-cyan/10"
          >
            TV Display ↗
          </Link>
        </nav>

        <ConnectionDot connected={connected} />
      </div>
    </header>
  );
}
