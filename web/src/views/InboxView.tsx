/**
 * The /inbox page: everything that waits for the signed-in person, in all their projects.
 * It lists merges that wait for a yes, merges that stopped, questions after an escalated conflict check or work that did
 * not merge, and tasks that wait for a person. Made for a phone: one column, big answers in place, no modal.
 * The list loads again every 20 seconds while the page shows (see state/inbox). A switch turns on push notifications for this device.
 */
import { useEffect, useId, useState } from "react";
import { Button, EmptyState, SkeletonRows, Textarea } from "../design/components";
import { Icon } from "../design/icons";
import { useMe } from "../state/account";
import { ago } from "../state/format";
import {
  currentSubscription,
  disablePush,
  dropInboxItem,
  enablePush,
  inboxLede,
  itemMeta,
  loadPushStatus,
  pushSupported,
  refreshInbox,
  useInbox,
  type InboxItem,
  type PushStatus,
} from "../state/inbox";
import { useNow } from "../app/useNow";
import { Link } from "../app/router";
import { SignInChoices } from "../app/Account";
import { answerApproval, useAnswering } from "../app/approvalActions";
import { QuestionCard } from "../app/QuestionCard";
import "./inbox.css";

/* ───────────── parts of the page ───────────── */

/** The age of an item: "5 min" (no "ago": the meta line reads "shop · 5 min"). */
function age(at: number, now: number): string {
  const t = ago(at, now);
  return t === "now" ? "now" : t.replace(/ ago$/, "");
}

/** A merge that waits for a yes, or a merge that stopped. */
function ApprovalItemCard({ item, now }: { item: InboxItem; now: number }) {
  const sending = useAnswering(item.approvalId ?? "");
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const uid = useId();
  const busy = sending !== null;
  const answer = async (answer: "approve" | "send-back") => {
    if (!item.attemptId || !item.approvalId) return;
    const r = await answerApproval({ attemptId: item.attemptId, approvalId: item.approvalId, answer, note: answer === "send-back" ? note : undefined, title: item.title, projectId: item.project });
    if (r.ok && r.kind !== "refused") {
      dropInboxItem(item.key);
      void refreshInbox();
    }
  };
  const yes = item.actions.find((a) => a.id === "approve");
  return (
    <article className="inbox-card" aria-labelledby={`${uid}-t`}>
      <p className="inbox-card__meta">{itemMeta(item, age(item.at, now))}</p>
      <h2 className="inbox-card__title voice-human" id={`${uid}-t`}>
        {item.title}
      </h2>
      <p className="inbox-card__headline">{item.headline}</p>
      <p className="inbox-card__line">
        {item.agent && <span className="voice-agent">{item.agent}</span>} {item.line}
      </p>
      <ul className="inbox-card__why">
        {item.why.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
      <div className="inbox-card__acts">
        <Button variant="primary" icon="merge" block busy={sending === "approve"} disabled={busy && sending !== "approve"} onClick={() => void answer("approve")}>
          {yes?.label ?? "Yes, merge"}
        </Button>
        <Button block aria-expanded={noteOpen} onClick={() => setNoteOpen((x) => !x)}>
          Send back…
        </Button>
      </div>
      {noteOpen && (
        <div className="inbox-card__note">
          <label className="inbox-card__notelabel" htmlFor={`${uid}-n`}>
            Tell the agent what to change <span className="apcard__opt">(optional)</span>
          </label>
          <Textarea id={`${uid}-n`} voice="human" rows={3} value={note} onChange={(e) => setNote(e.target.value)} autoFocus placeholder="For example: keep the old name of the function." />
          <Button block busy={sending === "send-back"} disabled={busy && sending !== "send-back"} onClick={() => void answer("send-back")}>
            Send back
          </Button>
        </div>
      )}
      <Link to={item.link} className="inbox-card__link">
        See the change <Icon name="arrow-right" size={14} />
      </Link>
    </article>
  );
}

function Item({ item, now }: { item: InboxItem; now: number }) {
  if (item.kind === "approval" || item.kind === "stopped") return <ApprovalItemCard item={item} now={now} />;
  if (item.kind === "question" && item.questionId) {
    return (
      <article className="inbox-card inbox-card--question">
        <p className="inbox-card__meta">{itemMeta(item, age(item.at, now))}</p>
        <QuestionCard
          projectId={item.project}
          questionId={item.questionId}
          title={item.title}
          headline={item.headline}
          facts={item.why}
          options={item.actions}
          mayAnswer
          to={item.link}
          variant="card"
          onDone={(r) => {
            if (r.outcome !== "refused") dropInboxItem(item.key);
            void refreshInbox();
          }}
        />
      </article>
    );
  }
  return (
    <article className="inbox-card">
      <p className="inbox-card__meta">{itemMeta(item, age(item.at, now))}</p>
      <h2 className="inbox-card__title voice-human">{item.title}</h2>
      <p className="inbox-card__headline">{item.headline}</p>
      {item.why[0] && <p className="inbox-card__line">{item.why[0]}</p>}
      <Link to={item.link} className="b-btn b-btn--primary b-btn--block inbox-card__open">
        Open the task
      </Link>
    </article>
  );
}

/** The switch for push notifications on this device. It does not show when the gitring has no push keys. */
function PushSwitch() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadPushStatus()
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus({ available: false, devices: 0 }));
    currentSubscription()
      .then((sub) => live && setOn(Boolean(sub)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (!status?.available || !status.publicKey || !pushSupported()) return null;
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      if (on) {
        await disablePush();
        setOn(false);
      } else {
        const r = await enablePush(status.publicKey!);
        if (r.ok) setOn(true);
        else setError(r.error);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="inbox-push">
      <p className="inbox-push__text">
        {on ? "This device gets a notification when something new waits for you." : "Get a notification on this device when something new waits for you."}
      </p>
      <Button size="sm" icon={on ? "pause" : "play"} busy={busy} onClick={() => void toggle()} aria-pressed={on}>
        {on ? "Turn off notifications" : "Turn on notifications"}
      </Button>
      {error && (
        <p className="inbox-push__error" role="alert">
          <Icon name="cross" size={12} /> {error}
        </p>
      )}
    </div>
  );
}

/* ───────────── the page ───────────── */

export function InboxView() {
  const me = useMe();
  const inbox = useInbox();
  const now = useNow(30_000);
  useEffect(() => {
    void refreshInbox();
  }, []);
  if (me && !me.user) {
    return (
      <div className="page inbox">
        <h1 className="page__title" tabIndex={-1}>
          Inbox
        </h1>
        <p className="page__lede">Sign in to see what waits for you: merges, questions and tasks of your projects.</p>
        <SignInChoices />
      </div>
    );
  }
  const items = inbox.items;
  return (
    <div className="page inbox">
      <h1 className="page__title" tabIndex={-1}>
        Inbox
      </h1>
      <p className="page__lede" aria-live="polite">
        {items ? inboxLede(items.length) : "gitring loads what waits for you."} <Link to="/account#acct-answers">Where do you answer merge questions?</Link>
      </p>
      <PushSwitch />
      {inbox.error && (
        <p className="inbox-error" role="alert">
          <Icon name="cross" size={14} /> gitring could not load the inbox. {inbox.error}{" "}
          <button type="button" onClick={() => void refreshInbox()}>
            Try again
          </button>
        </p>
      )}
      {!items ? (
        <SkeletonRows rows={3} label="Please wait for the inbox" />
      ) : items.length === 0 ? (
        <EmptyState text="Nothing waits for you. The agents work, and gitring merges what passes the tests." action={<Link to="/projects">Open the projects</Link>} />
      ) : (
        <ol className="inbox-list">
          {items.map((item) => (
            <li key={item.key}>
              <Item item={item} now={now} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
