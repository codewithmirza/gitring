/**
 * One row of the history list: the merge, its task, its agent and the files it changed.
 * A merge record starts to load when the pointer or the focus rests on the row.
 */
import { useEffect, useRef, type KeyboardEvent } from "react";
import { Badge, Callsign, MethodBadge } from "../../design/components";
import { Icon } from "../../design/icons";
import { Link } from "../../app/router";
import { harborOrNull } from "../../state/api";
import { ago, METHOD_TEXT, plural, shortSha } from "../../state/format";
import { type LogbookRow } from "../../state/selectors";
import { codeHref } from "../code/links";
import { trainText } from "../trains-copy";
import { openInApp, withProject } from "./links";

/** Files that a merge changed (from the work copy's footprint), newest knowledge first. */
export function changedFiles(r: LogbookRow): string[] {
  const fp = Object.keys(r.attempt?.footprint?.files ?? {});
  return fp.length ? fp : (r.attempt?.course.files ?? []);
}

/** Start loading a merge record (prefetch on hover or focus). Errors wait for the real open. */
function prefetchLanding(id: string) {
  void harborOrNull()
    ?.landing(id, { priority: "low" })
    .catch(() => undefined);
}

function rowLabel(r: LogbookRow, now: number, files: string[]): string {
  const total = r.landing.checks.passed + r.landing.checks.failed;
  return `${shortSha(r.landing.mainAfter)}: ${r.intent?.title ?? r.landing.intentId}. ${METHOD_TEXT[r.landing.method] ?? r.landing.method}. ${r.agent?.callsign ?? ""}. ${plural(
    r.corrections,
    "change request",
  )}. ${r.landing.checks.passed} of ${total} tests pass. ${plural(files.length, "file")} changed. ${ago(r.landing.at, now)}.`;
}

export function Row({ r, compact, selected, now, onKey }: { r: LogbookRow; compact: boolean; selected: boolean; now: number; onKey: (e: KeyboardEvent<HTMLAnchorElement>) => void }) {
  const total = r.landing.checks.passed + r.landing.checks.failed;
  const files = changedFiles(r);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => prefetchLanding(r.landing.id), 90);
  };
  const cool = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  useEffect(() => cool, []);
  return (
    <li className="lrow-item">
      <div className={["lrow", compact && "lrow--compact", selected && "is-selected"].filter(Boolean).join(" ")} onMouseEnter={warm} onMouseLeave={cool}>
        <span className="lrow__sha voice-agent">
          <Icon name="anchor" size={12} />
          {shortSha(r.landing.mainAfter)}
        </span>
        <span className="lrow__title voice-human">
          <Link
            to={`/history/${r.landing.id}`}
            className="lrow__link"
            data-lrow
            aria-current={selected ? "page" : undefined}
            aria-label={rowLabel(r, now, files)}
            onFocus={warm}
            onBlur={cool}
            onKeyDown={onKey}
          >
            {r.intent?.title ?? r.landing.intentId}
          </Link>
        </span>
        <span className="lrow__method">
          <MethodBadge method={r.landing.method} />
          {trainText(r.landing) && <Badge tone="neutral">{trainText(r.landing)}</Badge>}
          {r.landing.testsWhen === "after" && r.landing.method !== "revert" && <Badge tone="neutral">Tested after</Badge>}
        </span>
        <span className="lrow__agent">{r.agent && <Callsign callsign={r.agent.callsign} color={r.agent.color} model={r.agent.model} />}</span>
        <span className="lrow__corr">
          {r.corrections > 0 ? (
            <Badge tone="correction" icon="buoy">
              {plural(r.corrections, "change request")}
            </Badge>
          ) : (
            <span className="ink-3">No change requests</span>
          )}
        </span>
        <span className={`lrow__checks voice-agent ${r.landing.checks.ok ? "is-ok" : "is-fail"}`}>
          <Icon name={r.landing.checks.ok ? "check" : "cross"} size={12} />
          {r.landing.checks.passed}/{total}
          <span className="vh">{r.landing.checks.ok ? " tests pass" : " tests fail"}</span>
        </span>
        <span className="lrow__time ink-3">{ago(r.landing.at, now)}</span>
        {!compact && files.length > 0 && (
          <span className="lrow__files">
            {files.slice(0, 4).map((f) => (
              <a key={f} className="lrow__file voice-agent" href={withProject(codeHref(f, r.landing.mainAfter))} onClick={(e) => openInApp(e, codeHref(f, r.landing.mainAfter))} title={`Open ${f} as it was after this merge`}>
                {f}
              </a>
            ))}
            {files.length > 4 && <span className="lrow__more">+{files.length - 4} more</span>}
          </span>
        )}
      </div>
    </li>
  );
}
