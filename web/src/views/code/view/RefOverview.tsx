/**
 * What the code view shows when a ref has no file open: the work copy, the merge or main, with its changes and README.
 */
import { Icon } from "../../../design/icons";
import { Link } from "../../../app/router";
import { ago, ATTEMPT_STATUS_TEXT, plural, shortSha } from "../../../state/format";
import type { FileMarks } from "../annotations";
import { StaticCode } from "../CodeLines";
import { CodeLink } from "../CodeLink";
import { useFileText, type RefInfo } from "../data";
import { languageOf } from "../highlight";
import type { DiffFile } from "../../../state/api";
import { Dot } from "./Dot";
import { LinesSkeleton } from "./Skeletons";

export function RefOverview({
  info,
  marks,
  readme,
  readmePath,
  now,
  commitChanged,
  mergeTitle,
  diffFiles,
}: {
  info: RefInfo;
  marks: Map<string, FileMarks>;
  readme: ReturnType<typeof useFileText>;
  readmePath: string | null;
  now: number;
  commitChanged: Record<string, { status: "A" | "M" | "D"; additions: number; deletions: number }> | null;
  mergeTitle?: string;
  diffFiles?: DiffFile[];
}) {
  if (info.kind === "work") {
    const wc = info.wc;
    const changed = diffFiles ?? Object.entries(wc.changed).map(([path, t]) => ({ path, status: t.status, additions: t.additions, deletions: t.deletions, diff: "" }));
    return (
      <div className="cv-scroll">
        <article className="cv-over">
          <p className="cv-over__eyebrow">
            <Dot color={wc.color} /> Work copy of <strong>{wc.callsign}</strong> · {ATTEMPT_STATUS_TEXT[wc.status]} · updated {ago(wc.updatedAt, now)}
          </p>
          <h2 className="cv-over__title voice-human">{wc.intentTitle}</h2>
          {wc.approach && <p className="cv-over__approach voice-agent">{wc.approach}</p>}
          {wc.plan.length > 0 && (
            <ol className="cv-over__plan voice-agent">
              {wc.plan.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ol>
          )}
          <h3 className="cv-over__h">Changed files</h3>
          {changed.length ? (
            <ul className="cv-over__files" role="list">
              {changed.map((f) => (
                <li key={f.path}>
                  <span className={`cv-own cv-own--${f.status}`} aria-hidden="true">
                    {f.status}
                  </span>
                  <CodeLink to={{ ref: info.ref, path: f.path, view: "diff" }} className="voice-agent">
                    {f.path}
                  </CodeLink>
                  <span className="voice-agent cv-over__stat">
                    <span className="cv-plus">+{f.additions}</span> <span className="cv-minus">−{f.deletions}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="cv-note">No changes yet. The plan names {plural(wc.planned.length, "file")}.</p>
          )}
          <div className="cv-over__acts">
            {changed.length > 0 && (
              <CodeLink className="b-btn b-btn--primary" to={{ ref: info.ref, view: "diff" }}>
                Show all changes
              </CodeLink>
            )}
            <Link className="b-btn b-btn--ghost" to={`/tasks/${encodeURIComponent(wc.intentId)}`}>
              Open the task
            </Link>
          </div>
        </article>
      </div>
    );
  }
  const working = [...marks.entries()]
    .filter(([, fm]) => fm.work.length || fm.keepOut.length)
    .sort((a, b) => b[1].work.length - a[1].work.length || a[0].localeCompare(b[0]))
    .slice(0, 12);
  const mergeFiles = commitChanged && (
    <ul className="cv-over__files" role="list">
      {Object.entries(commitChanged).map(([p, t]) => (
        <li key={p}>
          <span className={`cv-own cv-own--${t.status}`} aria-hidden="true">
            {t.status}
          </span>
          {t.status === "D" ? (
            <span className="voice-agent">{p}</span>
          ) : (
            <CodeLink to={{ ref: info.kind === "commit" ? info.ref : "main", path: p }} className="voice-agent">
              {p}
            </CodeLink>
          )}
          <span className="vh">{t.status === "A" ? ", added" : t.status === "D" ? ", deleted" : ", changed"}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="cv-scroll">
      <article className="cv-over">
        {info.kind === "commit" ? (
          <>
            <p className="cv-over__eyebrow">
              <Icon name="commit" size={12} /> Commit {shortSha(info.sha)} · an earlier state of main
            </p>
            <h2 className="cv-over__title">{mergeTitle ? <>Main after “<span className="voice-human">{mergeTitle}</span>”</> : "Files of this commit"}</h2>
            {mergeFiles}
          </>
        ) : (
          <>
            <h2 className="cv-over__h">Where agents work</h2>
            {working.length ? (
              <ul className="cv-over__files" role="list">
                {working.map(([p, fm]) => (
                  <li key={p}>
                    <span className="cv-over__dots" aria-hidden="true">
                      {fm.work.slice(0, 3).map((w) => (
                        <Dot key={w.wc.id} color={w.wc.color} ring={!w.touch} />
                      ))}
                      {fm.keepOut.length > 0 && <span className="cv-keep" />}
                    </span>
                    <CodeLink to={{ ref: "main", path: p }} className="voice-agent">
                      {p}
                    </CodeLink>
                    <span className="cv-over__who">
                      {fm.work.map((w) => `${w.wc.callsign}${w.touch ? "" : " (plan)"}`).join(", ")}
                      {fm.keepOut.length ? ` · ${plural(fm.keepOut.length, "change request")}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cv-note">No agent works on main now. Choose a file, or press t to find one.</p>
            )}
            {mergeTitle && commitChanged && (
              <>
                <h2 className="cv-over__h">
                  Last merge: <span className="voice-human">{mergeTitle}</span>
                </h2>
                {mergeFiles}
              </>
            )}
          </>
        )}
        {readmePath && readme && (
          <section className="cv-readme" aria-label={readmePath}>
            <h3 className="cv-over__h voice-agent">{readmePath}</h3>
            {readme.status === "ready" ? (
              <StaticCode text={readme.data} info={languageOf(readmePath)} />
            ) : readme.status === "error" ? (
              <p className="cv-note">gitring could not load {readmePath}.</p>
            ) : (
              <LinesSkeleton rows={6} />
            )}
          </section>
        )}
      </article>
    </div>
  );
}
