import clsx from "clsx";

export function BottleImage({
  src,
  alt,
  color,
  className,
  glow = true,
}: {
  src: string;
  alt: string;
  color?: string;
  className?: string;
  glow?: boolean;
}) {
  return (
    <div className={clsx("relative flex items-center justify-center", className)}>
      {glow && (
        <div
          className="absolute inset-0 -z-10 rounded-full blur-3xl opacity-40"
          style={{ background: color ?? "#A855F7" }}
        />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className="h-full max-h-full w-auto drop-shadow-[0_20px_45px_rgba(0,0,0,0.55)]"
        draggable={false}
      />
    </div>
  );
}
