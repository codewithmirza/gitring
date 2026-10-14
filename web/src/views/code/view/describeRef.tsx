/**
 * Words for the ref on screen: the label of the toolbar button, a plain text, the ref that "Why" asks about and who may ask the agent.
 * It is a plain function, not a hook: it reads only what it is given.
 */
import type { ReactNode } from "react";
import { Icon } from "../../../design/icons";
import { shortSha } from "../../../state/format";
import { lineRequester, mayRequestLines } from "../../../app/lineRequest";
import { Dot } from "./Dot";
import type { CodeSource } from "./useCodeSource";

export function describeRef(source: CodeSource) {
  const { info, mainSha, loc, canAct, projectId } = source;
  /* ── labels ── */
  const refLabel: ReactNode =
    info.kind === "main" ? (
      <>
        <span className="cv-dot cv-dot--main" aria-hidden="true" />
        <span className="cv-refbtn__name">main</span>
        <span className="cv-refbtn__sha voice-agent">{shortSha(mainSha)}</span>
      </>
    ) : info.kind === "work" ? (
      <>
        <Dot color={info.wc.color} />
        <span className="cv-refbtn__name">{info.wc.callsign}</span>
        <span className="cv-refbtn__sha voice-human">{info.wc.intentTitle}</span>
      </>
    ) : info.kind === "commit" ? (
      <>
        <Icon name="commit" size={14} />
        <span className="cv-refbtn__name">commit</span>
        <span className="cv-refbtn__sha voice-agent">{shortSha(info.sha)}</span>
      </>
    ) : (
      <>
        <Icon name="info" size={14} />
        <span className="cv-refbtn__name voice-agent">{shortSha(loc.ref, 12)}</span>
      </>
    );
  const refText = info.kind === "main" ? `main ${shortSha(mainSha)}` : info.kind === "work" ? `the work copy of ${info.wc.callsign}` : info.kind === "commit" ? `commit ${shortSha(info.sha)}` : loc.ref;
  /** The version that "Why line N?" asks about. */
  const whyRef = info.kind === "work" ? info.ref : info.kind === "commit" ? info.sha : "main";

  // A member asks the agent of an active work copy to change lines of its diff.
  const askAgent = info.kind === "work" && canAct && mayRequestLines(info.attempt) ? lineRequester(projectId, info.attempt.id, info.wc.callsign) : undefined;

  return { refLabel, refText, whyRef, askAgent };
}

export type RefLabels = ReturnType<typeof describeRef>;
