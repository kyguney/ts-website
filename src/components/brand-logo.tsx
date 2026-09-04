import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * TrendScore brand logo (bull + wordmark). The source image is a horizontal
 * logo, so we constrain by HEIGHT and let width scale automatically.
 *
 * Place the logo file at: public/logo.png
 */
export function BrandLogo({
  href = "/",
  height = 32,
  className,
  priority = false,
}: {
  href?: string | null;
  height?: number;
  className?: string;
  priority?: boolean;
}) {
  const img = (
    <Image
      src="/logo.png"
      alt="TrendScore.io"
      // Pass the FULL intrinsic size so the optimizer keeps source resolution;
      // the display size is controlled by CSS height below (stays crisp, incl.
      // on retina). quality 90 avoids soft/over-compressed edges.
      width={1536}
      height={1024}
      quality={90}
      priority={priority}
      // Hint a generous rendered width so the optimizer serves a high-res
      // candidate (avoids the browser picking a small, blurry 256px source).
      sizes="320px"
      className={cn("w-auto object-contain", className)}
      style={{ height, width: "auto" }}
    />
  );

  if (href === null) return img;

  return (
    <Link href={href} className="inline-flex items-center" aria-label="TrendScore.io">
      {img}
    </Link>
  );
}
