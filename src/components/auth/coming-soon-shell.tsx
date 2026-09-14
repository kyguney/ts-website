import Image from "next/image";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { FacetsBackground } from "@/components/landing/facets-background";

/**
 * ComingSoonShell — a reusable page wrapper that reproduces the exact ambient
 * atmosphere of the Coming Soon page (see `components/coming-soon.tsx`):
 *   - the `.ts-landing` canvas gradient + corner glows (defined in globals.css)
 *   - the crystalline `FacetsBackground` shard clusters
 *   - the crystalline bull accent anchored bottom-right
 *
 * It intentionally does NOT modify the Coming Soon page; it simply reuses the
 * same building blocks so any view (e.g. the Registration page) can inherit the
 * identical background design and theme.
 *
 * Children are vertically + horizontally centered within the viewport with
 * responsive padding.
 *
 * `showBull` toggles the crystalline bull accent (default true). The register
 * page opts out of it.
 *
 * `showBackToHome` renders a "Back to home" link at the top-left (default off).
 * The auth pages (login / register) enable it.
 */
export function ComingSoonShell({
  children,
  showBull = true,
  facetsVariant = "default",
  showBackToHome = false,
}: {
  children: React.ReactNode;
  showBull?: boolean;
  facetsVariant?: "default" | "sides";
  showBackToHome?: boolean;
}) {
  return (
    <div className="ts-landing relative flex min-h-screen flex-col overflow-hidden">
      {/* Decorative crystalline facet shards behind content. */}
      <FacetsBackground variant={facetsVariant} />

      {/* Back to home */}
      {showBackToHome && (
        <Link
          href="/"
          className="absolute left-4 top-4 z-20 inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-4 py-2 text-sm text-muted-foreground backdrop-blur transition-colors hover:border-[var(--ts-emerald)]/50 hover:text-foreground sm:left-6 sm:top-6"
        >
          <ArrowLeft className="size-4" />
          Back to home
        </Link>
      )}

      {/* Crystalline bull accent, bottom-right — identical to Coming Soon. */}
      {showBull && (
        <Image
          src="/footer-bg-transparent.webp"
          alt=""
          aria-hidden
          width={2400}
          height={1601}
          unoptimized
          className="pointer-events-none absolute bottom-0 right-0 z-0 h-auto w-[80%] max-w-[760px] select-none object-contain object-right-bottom opacity-20 sm:w-[56%] sm:opacity-25 lg:w-[46%]"
        />
      )}

      {/* Centered content region. */}
      <main className="relative z-10 flex flex-1 items-center justify-center px-4 py-10 sm:px-6 sm:py-16">
        {children}
      </main>
    </div>
  );
}
