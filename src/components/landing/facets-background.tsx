/**
 * Decorative crystalline "facet" background shards. Low-poly blue shard clusters
 * hug the page corners (top-left, top-right, mid-left, bottom-right) behind all
 * landing content, recreating the royal-blue shard artwork in pure SVG (no image
 * asset). Purely decorative — hidden from assistive tech.
 */

/** One shard cluster — polygon geometry + fills verbatim from the reference. */
function ShardCluster({ className }: { className: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 300 700"
      aria-hidden="true"
      focusable="false"
    >
      <polygon points="0,0 160,65 30,170" fill="#0A66C2" />
      <polygon points="0,0 30,170 0,260" fill="#023E8A" />
      <polygon points="160,65 30,170 95,280" fill="#07467B" />
      <polygon points="0,260 30,170 95,280" fill="#082C51" />
      <polygon points="0,260 95,280 20,440" fill="#06528E" />
      <polygon points="95,280 20,440 170,530" fill="#052B50" />
      <polygon points="20,440 0,590 170,530" fill="#023E8A" />
      <polygon points="0,590 170,530 70,700" fill="#07325B" />
    </svg>
  );
}

/**
 * @param variant
 *   "default" — top-left, top-right, and mid-left clusters (Coming Soon page).
 *   "sides"   — only vertically-centered, taller left + right clusters, no
 *               mid-left shape (used by the register shell).
 */
export function FacetsBackground({
  variant = "default",
}: {
  variant?: "default" | "sides";
}) {
  if (variant === "sides") {
    return (
      <>
        <ShardCluster className="ts-facets ts-facets--left-center" />
        <ShardCluster className="ts-facets ts-facets--right-center" />
      </>
    );
  }

  return (
    <>
      <ShardCluster className="ts-facets ts-facets--tl" />
      <ShardCluster className="ts-facets ts-facets--tr" />
      <ShardCluster className="ts-facets ts-facets--ml" />
      {/* Bottom-right cluster intentionally omitted — the footer's crystalline
          bull occupies that corner instead. */}
    </>
  );
}
