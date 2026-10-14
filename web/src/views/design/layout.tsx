/**
 * The layout parts of the style guide: the table of contents, a titled section and a specimen box.
 */
import type { ReactNode } from "react";

export const TOC: [string, string][] = [
  ["principles", "Principles"],
  ["themes", "Themes and color"],
  ["voices", "Three voices"],
  ["type", "Type scale"],
  ["space", "Space, shape, depth"],
  ["motion", "Motion"],
  ["icons", "Icons"],
  ["components", "Components"],
  ["chart", "Chart primitives"],
  ["patterns", "Patterns"],
  ["a11y", "Accessibility"],
  ["copy", "Copy rules"],
];

export function Section({ id, title, lede, children }: { id: string; title: string; lede?: ReactNode; children: ReactNode }) {
  return (
    <section className="ds-section" id={id} aria-labelledby={`${id}-h`}>
      <h2 className="ds-h2" id={`${id}-h`}>
        <a href={`#${id}`} className="ds-anchor" aria-hidden="true" tabIndex={-1}>
          #
        </a>
        {title}
      </h2>
      {lede && <p className="ds-lede">{lede}</p>}
      {children}
    </section>
  );
}

export function Specimen({ title, note, children, wide }: { title: string; note?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={["ds-spec", wide && "ds-spec--wide"].filter(Boolean).join(" ")}>
      <div className="ds-spec__head">
        <h3 className="ds-h3">{title}</h3>
        {note && <p className="ds-spec__note">{note}</p>}
      </div>
      <div className="ds-spec__body">{children}</div>
    </div>
  );
}
