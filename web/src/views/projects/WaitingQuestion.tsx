/**
 * The question that waits in a project, shown on the project card with its answer in place.
 * A merge question has "Yes, merge" right here and a link to the change. Any other question opens its task.
 * Never answers by itself: it sends the same request as the inbox and the tray (answerApproval).
 */
import { useId } from "react";
import { Button } from "../../design/components";
import { answerApproval, useAnswering } from "../../app/approvalActions";
import { Link } from "../../app/router";
import { dropInboxItem, refreshInbox, type InboxItem } from "../../state/inbox";

export function WaitingQuestion({ item, more }: { item: InboxItem; more: number }) {
  const titleId = useId();
  const sending = useAnswering(item.approvalId ?? "");
  const isMerge = (item.kind === "approval" || item.kind === "stopped") && item.attemptId && item.approvalId;
  const yes = item.actions.find((a) => a.primary) ?? item.actions[0];

  const answer = async () => {
    if (!item.attemptId || !item.approvalId) return;
    const r = await answerApproval({ attemptId: item.attemptId, approvalId: item.approvalId, answer: "approve", title: item.title, projectId: item.project });
    if (r.ok && r.kind !== "refused") {
      dropInboxItem(item.key);
      void refreshInbox();
    }
  };

  return (
    <div className="pj-ask" role="group" aria-labelledby={titleId}>
      <p className="pj-ask__title voice-human" id={titleId}>
        {item.title}
      </p>
      <p className="pj-ask__line">
        {item.agent && <span className="voice-agent">{item.agent}</span>} {item.line ?? item.headline}
      </p>
      <div className="pj-ask__acts">
        {isMerge ? (
          <>
            <Button size="sm" variant="primary" icon="merge" busy={sending === "approve"} aria-describedby={titleId} onClick={() => void answer()}>
              {yes?.label ?? "Yes, merge"}
            </Button>
            <Link to={item.link} className="pj-ask__link">
              See the change
            </Link>
          </>
        ) : (
          <Link to={item.link} className="b-btn b-btn--primary b-btn--sm">
            {item.kind === "task" ? "Open the task" : "Answer the question"}
          </Link>
        )}
      </div>
      {more > 0 && (
        <Link to="/inbox" className="pj-ask__more">
          {more === 1 ? "1 more question in the inbox" : `${more} more questions in the inbox`}
        </Link>
      )}
    </div>
  );
}
