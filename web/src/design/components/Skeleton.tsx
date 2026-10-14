/**
 * Grey loading shapes in the layout of the content that loads. They show only after 200 ms.
 * A fast load shows nothing.
 */
import type { CSSProperties } from "react";

/**
 * Skeletons: grey shapes in the layout of the content that loads. They show only after 200 ms, so a fast
 * load shows nothing (no flash). With reduced motion they do not shimmer.
 */
export function Skeleton({ width, height = 12, radius, className, style }: { width?: number | string; height?: number; radius?: number; className?: string; style?: CSSProperties }) {
  return <span className={["b-skel", className].filter(Boolean).join(" ")} style={{ width, height, borderRadius: radius, ...style }} aria-hidden="true" />;
}

function Rows({ rows }: { rows: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="b-skel-row">
          <Skeleton width={`${62 + ((i * 23) % 30)}%`} height={13} />
          <Skeleton width={`${30 + ((i * 17) % 25)}%`} height={9} />
        </div>
      ))}
    </>
  );
}

/** Rows of a list: a title line and a meta line each. */
export function SkeletonRows({ rows = 6, label = "Please wait" }: { rows?: number; label?: string }) {
  return (
    <div className="b-skel-rows" role="status" aria-label={label}>
      <Rows rows={rows} />
    </div>
  );
}

/** A page: a heading, a lede and blocks. */
export function SkeletonPage({ label = "Please wait" }: { label?: string }) {
  return (
    <div className="b-skel-page" role="status" aria-label={label}>
      <Skeleton width={220} height={26} />
      <Skeleton width="min(560px, 90%)" height={14} />
      <Skeleton width="min(420px, 70%)" height={14} />
      <div className="b-skel-page__blocks">
        <Skeleton height={120} radius={6} />
        <Skeleton height={120} radius={6} />
      </div>
    </div>
  );
}

/** A project view: the task rail on the left and the work area on the right. */
export function SkeletonSplit({ label = "Please wait for the project" }: { label?: string }) {
  return (
    <div className="b-skel-split" role="status" aria-label={label}>
      <div className="b-skel-split__rail b-skel-rows">
        <Rows rows={7} />
      </div>
      <div className="b-skel-split__main">
        <Skeleton width={260} height={24} />
        <Skeleton width="min(520px, 80%)" height={14} />
        <Skeleton height={220} radius={6} />
      </div>
    </div>
  );
}
