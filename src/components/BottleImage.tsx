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
          className="absolute inset-0 -z-10 rounded-full blur-3xl opacity-[0.14]"
          style={{ background: color ?? "#B89A5C" }}
        />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className="h-full max-h-full w-auto drop-shadow-[0_12px_20px_rgba(47,46,34,0.18)]"
        draggable={false}
      />
    </div>
  );
}
