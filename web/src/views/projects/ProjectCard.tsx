/**
 * The cards of the projects page. Each card leads with what the browser knows is live: a question that waits.
 * Then come the facts, and the source of the project goes last. A waiting merge question shows on the card with its answer.
 * ProjectsView.tsx calls it. It reads the inbox state (state/inbox.ts) and never writes it.
 */
import { useMemo, type MouseEvent } from "react";
import type { ProjectInfo } from "../../../../src/core/accounts";
import { Icon } from "../../design/icons";
import { openProject } from "../../state/account";
import { useInbox } from "../../state/inbox";
import { GithubMark, LockIcon, RepoIcon } from "../newproject/marks";
import { canAnswerHere, cardFacts, NOTHING_WAITS, sourceLine, waitingByProject, waitsText } from "./card-text";
import { WaitingQuestion } from "./WaitingQuestion";

function SourceIcon({ p }: { p: ProjectInfo }) {
  if (p.source.kind === "github") return <GithubMark className="pj-card__icon" />;
  if (p.source.kind === "git") return <Icon name="fork" className="pj-card__icon" />;
  if (p.source.kind === "upload") return <Icon name="launch" className="pj-card__icon" />;
  if (p.source.kind === "template") return <Icon name="grid" className="pj-card__icon" />;
  return <RepoIcon className="pj-card__icon" />;
}

export function ProjectGrid({ list, current }: { list: ProjectInfo[]; current: string }) {
  const inbox = useInbox();
  const waiting = useMemo(() => waitingByProject(inbox.items), [inbox.items]);
  const open = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    // A plain click opens the project here; a modified click opens a new tab as usual.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openProject(id);
  };
  return (
    <ul className="pj-grid">
      {list.map((p) => {
        const isOpen = p.id === current;
        const questions = waiting?.get(p.id) ?? [];
        return (
          <li key={p.id} className={["pj-card", isOpen && "is-current", questions.length > 0 && "has-question"].filter(Boolean).join(" ")}>
            <a className="pj-card__link" href={`/overview?project=${encodeURIComponent(p.id)}`} aria-current={isOpen ? "true" : undefined} onClick={(e) => open(e, p.id)}>
              <span className="pj-card__top">
                <SourceIcon p={p} />
                <span className="pj-card__name">{p.name}</span>
                {p.visibility === "private" && (
                  <span className="pj-card__lock" title="Private">
                    <LockIcon size={12} />
                    <span className="vh">Private</span>
                  </span>
                )}
              </span>
            </a>
            {questions.length > 0 ? (
              <p className="pj-card__live pj-card__live--waits">
                <Icon name="inbox" size={14} /> {waitsText(questions.length)}
              </p>
            ) : (
              waiting && canAnswerHere(p) && <p className="pj-card__live">{NOTHING_WAITS}</p>
            )}
            {questions.length > 0 && <WaitingQuestion item={questions[0]} more={questions.length - 1} />}
            <p className="pj-card__facts">
              {cardFacts(p, isOpen).map((fact) => (
                <span key={fact}>{fact}</span>
              ))}
            </p>
            <p className="pj-card__source voice-agent">{sourceLine(p)}</p>
          </li>
        );
      })}
    </ul>
  );
}
