/**
 * The loading shapes of the code view: grey lines for a file and for the file tree.
 */
export function LinesSkeleton({ rows = 18 }: { rows?: number }) {
  return (
    <div className="cv-skel" role="status" aria-label="Please wait for the file">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="cv-skel__line" style={{ width: `${18 + ((i * 37) % 60)}%`, marginLeft: `${(i % 4) * 2}ch` }} />
      ))}
    </div>
  );
}

export function TreeSkeleton() {
  return (
    <div className="cv-skel cv-skel--tree" role="status" aria-label="Please wait for the files">
      {Array.from({ length: 12 }, (_, i) => (
        <span key={i} className="cv-skel__line" style={{ width: `${40 + ((i * 29) % 45)}%`, marginLeft: `${(i % 3) * 14}px` }} />
      ))}
    </div>
  );
}
