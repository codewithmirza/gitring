import { useEffect, useRef, useState } from "react";
import { IconButton } from "./Button";

interface PreviewFrameProps {
  title: string;
  /** Live preview URL (Dynamic Worker), e.g. /preview/demo/at-dark-1/ */
  src?: string | null;
  height?: number | string;
  path?: string;
}

/**
 * PreviewFrame: the real running attempt in a sandboxed iframe (no same-origin
 * access), with a URL bar, reload and open. Real code, not screenshots.
 */
export function PreviewFrame({ title, src, height = 280, path: initialPath = "/" }: PreviewFrameProps) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [path, setPath] = useState(initialPath);
  const [draft, setDraft] = useState(initialPath);
  const [status, setStatus] = useState<number | null>(null);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data as { type?: string; path?: string; status?: number };
      if (d?.type === "gitring-preview" && typeof d.path === "string") {
        setPath(d.path);
        setDraft(d.path);
        setStatus(typeof d.status === "number" ? d.status : null);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const base = src ? src.replace(/\/$/, "") : null;
  const go = (p: string) => {
    const clean = p.startsWith("/") ? p : `/${p}`;
    if (base && frame.current) {
      frame.current.src = base + clean;
      setPath(clean);
    }
  };
  const reload = () => {
    if (frame.current && base) frame.current.src = base + path;
  };
  const open = () => {
    if (base) window.open(base + path, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="b-preview" style={{ height }}>
      <div className="b-preview__bar">
        <IconButton icon="reload" label="Reload preview" size="sm" onClick={reload} />
        <form
          style={{ display: "contents" }}
          onSubmit={(e) => {
            e.preventDefault();
            go(draft);
          }}
        >
          <input
            className="b-preview__url"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={`Preview path for ${title}`}
            spellCheck={false}
          />
        </form>
        {status !== null && status >= 400 && <span className="voice-agent t-xs" style={{ color: "var(--danger)" }}>{status}</span>}
        <IconButton
          icon="external"
          label={base ? "Open preview in a new tab" : "No preview yet"}
          size="sm"
          disabled={!base}
          onClick={open}
        />
      </div>
      <div className="b-preview__frame">
        {base ? (
          <iframe
            ref={frame}
            title={`Live preview of ${title}`}
            src={base + initialPath}
            sandbox="allow-scripts allow-forms allow-popups"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
        ) : null}
      </div>
    </div>
  );
}
