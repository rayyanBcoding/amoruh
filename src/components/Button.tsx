"use client";

import clsx from "clsx";
import { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "cyan" | "danger" | "ghost" | "outline";
type Size = "md" | "lg" | "xl";

const VARIANT_STYLES: Record<Variant, string> = {
  primary:
    "bg-gradient-to-r from-ld-purple to-ld-purple-dim text-ld-white shadow-sm shadow-ld-purple/20 hover:brightness-105 active:brightness-95",
  cyan: "bg-ld-cyan text-ld-bg shadow-sm shadow-ld-cyan/15 hover:brightness-125 active:brightness-95",
  danger:
    "bg-ld-red/10 text-ld-red ring-1 ring-inset ring-ld-red/35 hover:bg-ld-red/15",
  ghost: "bg-ld-bg-elevated text-ld-white hover:bg-ld-border/40 ring-1 ring-inset ring-ld-border",
  outline: "bg-transparent text-ld-white ring-1 ring-inset ring-ld-border hover:bg-ld-bg-elevated",
};

const SIZE_STYLES: Record<Size, string> = {
  md: "px-4 py-2.5 text-sm rounded-lg gap-2",
  lg: "px-6 py-4 text-base rounded-xl gap-2.5",
  xl: "px-8 py-5 text-lg rounded-2xl gap-3",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  fullWidth?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  icon,
  fullWidth,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={clsx(
        "inline-flex items-center justify-center font-bold tracking-tight transition-all duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100",
        VARIANT_STYLES[variant],
        SIZE_STYLES[size],
        fullWidth && "w-full",
        className
      )}
      disabled={disabled}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}
