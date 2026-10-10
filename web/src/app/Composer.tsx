/**
 * The task composer: "Write a task…" at the top of the task rail. A click or the key n opens it in place.
 * One field is enough (the title); the goal, a test file, the agents and the priority have defaults.
 * The draft stays in this browser per project, through Escape, page loads and the sign-in redirect.
 * A sent task shows at once as "Sending…" in the list; if the send fails, the text comes back.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button, Popover, usePopover } from "../design/components";
import { Icon } from "../design/icons";
import { harbor } from "../state/api";
import { slugify } from "../state/format";
import { useStore } from "../state/store";
import { useCanAct } from "../state/account";
import { FanoutPicker, launchTask } from "./LaunchControl";
import { Link, navigate, useRoute } from "./router";
import { addPending, closeComposer, dropPending, updatePending, useUi, type TaskDraft } from "./ui";
import { toast } from "../design/components";
import { MOD } from "./keys";
import { splitTask } from "./taskText";

export type { TaskDraft };

const BLANK: TaskDraft = { title: "", goal: "", checkPath: "", checkCode: "", priority: "normal", fanout: null, models: null };
const EMPTY: string[] = [];

const draftKey = (project: string) => `gitring.draft.${project || "none"}`;

export function readDraft(project: string): TaskDraft {
  try {
    const v = JSON.parse(localStorage.getItem(draftKey(project)) ?? "null");
    return v && typeof v === "object" ? { ...BLANK, ...v } : BLANK;
  } catch {
    return BLANK;
  }
}

export function writeDraft(project: string, d: TaskDraft) {
  try {
    const empty = !d.title.trim() && !d.goal.trim() && !d.checkCode.trim() && !d.checkPath.trim();
    if (empty) localStorage.removeItem(draftKey(project));
    else localStorage.setItem(draftKey(project), JSON.stringify(d));
  } catch {
    /* storage off: the draft lives until the page closes */
  }
}

function readStart(): boolean {
  try {
    return localStorage.getItem("gitring.composer.start") !== "0";
  } catch {
    return true;
  }
}

const CHECK_PLACEHOLDER = `import { test, expect } from "../harness/test.js";
import worker from "../src/index.js";

test("shows the new feature", async () => {
  const res = await worker.fetch(new Request("https://shop.test/"));
  expect(await res.text()).toContain("…");
});`;

const CONTAINER_PLACEHOLDER = `import { test } from "node:test";
import assert from "node:assert/strict";
import { feature } from "../src/feature.js";

test("does the new thing", () => {
  assert.equal(feature("input"), "expected output");
});`;

export function TaskComposer({ autoOpen = false }: { autoOpen?: boolean }) {
  const ui = useUi();
  const route = useRoute();
  const projectId = useStore((s) => s.projectId);
  const available = useStore((s) => s.state?.project.settings.agentModels ?? EMPTY);
  const defaultFanout = useStore((s) => s.state?.project.settings.fanout ?? 1);
  const container = useStore((s) => s.state?.project.settings.checks?.runner === "container");
  const canAct = useCanAct();
  const [draft, setDraftState] = useState<TaskDraft>(() => readDraft(projectId));
  const [start, setStartState] = useState(readStart);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testOpen, setTestOpen] = useState(() => Boolean(draft.checkCode || draft.checkPath));
  // With no tasks yet, the composer starts open: it is the first step.
  const [localOpen, setLocalOpen] = useState(autoOpen);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const ghostRef = useRef<HTMLButtonElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const agents = usePopover();
  const uid = useId();
  const open = ui.composer || localOpen;

  useEffect(() => {
    setDraftState(readDraft(projectId));
  }, [projectId]);

  const setDraft = useCallback(
    (patch: Partial<TaskDraft>) => {
      setDraftState((d) => {
        const next = { ...d, ...patch };
        writeDraft(projectId, next);
        return next;
      });
    },
    [projectId],
  );

  const setStart = (v: boolean) => {
    setStartState(v);
    try {
      localStorage.setItem("gitring.composer.start", v ? "1" : "0");
    } catch {
      /* storage off */
    }
  };

  // Focus moves in the same frame as the opening: keys typed right after n land in the title.
  const wantFocus = useRef(false);
  useLayoutEffect(() => {
    if (!wantFocus.current) return;
    const el = titleRef.current;
    if (!el) return;
    wantFocus.current = false;
    if (el.getClientRects().length > 0) {
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
  });

  // n, "New task" and the palette ask for focus: take it when this composer is on screen.
  useLayoutEffect(() => {
    if (!ui.composerFocus || !ui.composer) return;
    // "Edit" on a failed task writes its text to the draft: read it again.
    setDraftState(readDraft(projectId));
    wantFocus.current = true;
    const el = titleRef.current;
    if (el && el.getClientRects().length > 0) {
      wantFocus.current = false;
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
    // projectId is read at the time of the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.composerFocus, ui.composer]);

  if (!canAct) return null;

  const fanout = Math.min(4, Math.max(1, draft.fanout ?? defaultFanout));
  const models = draft.models ?? available;
  const canStart = available.length > 0;
  const willStart = start && canStart;
  const slug = slugify(splitTask(draft.title, draft.goal).title) || "new-task";
  const noTitle = tried && !draft.title.trim() && !draft.goal.trim();

  const collapse = () => {
    setLocalOpen(false);
    closeComposer();
    setTried(false);
    requestAnimationFrame(() => ghostRef.current?.focus());
  };

  const submit = async (keepOpen: boolean) => {
    setTried(true);
    const t = splitTask(draft.title, draft.goal);
    if (!t.title) {
      titleRef.current?.focus();
      return;
    }
    const snapshot = draft;
    const key = `pending-${Date.now()}`;
    addPending({ key, title: t.title, state: "sending", at: Date.now() });
    // Clear at once: the task is on its way. The text comes back if the send fails.
    setDraft({ title: "", goal: "", checkPath: "", checkCode: "" });
    setTestOpen(false);
    setTried(false);
    setError(null);
    if (keepOpen) titleRef.current?.focus();
    else collapse();
    try {
      const intent = await harbor().createIntent({
        title: t.title,
        goal: t.goal,
        priority: snapshot.priority,
        checks: snapshot.checkCode.trim()
          ? [{ path: snapshot.checkPath.trim() || `tests/${slugify(t.title) || "new-task"}.test.js`, content: snapshot.checkCode, description: `Tests for “${t.title}”.` }]
          : undefined,
      });
      updatePending(key, { intentId: intent.id });
      const openIt = { label: "Open the task", onClick: () => navigate(`/tasks/${intent.id}`) };
      if (willStart) {
        const ok = await launchTask(intent, fanout, models);
        if (!ok) toast({ tone: "info", title: "The task is open", text: "Start agents from the task when you are ready.", action: openIt });
      } else {
        toast({ tone: "info", title: "Task open", text: `Start agents for “${intent.title}” when you are ready.`, action: openIt });
      }
      if (route.name === "intents" && !keepOpen) navigate(`/tasks/${intent.id}`);
    } catch (e) {
      const msg = (e as Error).message;
      updatePending(key, { state: "error", error: msg });
      // Give the text back when the composer is empty; else the row keeps it ("Edit").
      const cur = readDraft(projectId);
      if (!cur.title.trim() && !cur.goal.trim()) {
        dropPending(key);
        setDraft(snapshot);
        setTestOpen(Boolean(snapshot.checkCode || snapshot.checkPath));
        wantFocus.current = true;
        setLocalOpen(true);
        setError(`The task was not created: ${msg} Your text is safe.`);
      } else {
        updatePending(key, { state: "error", error: msg, draft: snapshot });
      }
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(false);
  };

  const onKey = (e: KeyboardEvent<HTMLFormElement>) => {
    // Keys in the agents popover (a portal) also bubble here through React: leave them to the popover.
    if (!e.currentTarget.contains(e.target as Node)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      collapse();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit(e.shiftKey);
    }
  };

  if (!open) {
    const hasDraft = Boolean(draft.title.trim() || draft.goal.trim());
    return (
      <button
        ref={ghostRef}
        type="button"
        className="composer__ghost"
        data-composer=""
        onClick={() => {
          wantFocus.current = true;
          setLocalOpen(true);
        }}
        aria-keyshortcuts="n"
      >
        <Icon name="plus" />
        <span className={hasDraft ? "composer__ghosttext voice-human" : "composer__ghosttext"}>{hasDraft ? draft.title || draft.goal : "Write a task…"}</span>
        {hasDraft ? <span className="composer__draft">Draft</span> : <kbd className="b-kbd">n</kbd>}
      </button>
    );
  }

  return (
    <form ref={formRef} className="composer" data-composer="" onSubmit={onSubmit} onKeyDown={onKey} aria-label="New task" noValidate>
      <label className="vh" htmlFor={`${uid}-title`}>
        Title
      </label>
      <input
        ref={titleRef}
        id={`${uid}-title`}
        className="composer__title voice-human"
        placeholder="What must change?"
        value={draft.title}
        onChange={(e) => setDraft({ title: e.target.value })}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (!text.includes("\n")) return;
          e.preventDefault();
          const parts = splitTask(text, draft.goal);
          setDraft({ title: parts.title, goal: parts.goal === parts.title ? draft.goal : parts.goal });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            document.getElementById(`${uid}-goal`)?.focus();
          }
        }}
        autoComplete="off"
        aria-invalid={noTitle || undefined}
        aria-describedby={noTitle ? `${uid}-err` : `${uid}-help`}
        maxLength={140}
      />
      <label className="vh" htmlFor={`${uid}-goal`}>
        Goal
      </label>
      <textarea
        id={`${uid}-goal`}
        className="composer__goal voice-human"
        placeholder="The goal in one or two sentences. Say what done looks like."
        rows={2}
        value={draft.goal}
        onChange={(e) => setDraft({ goal: e.target.value })}
      />
      {noTitle && (
        <p className="composer__error" id={`${uid}-err`} role="alert">
          <Icon name="cross" size={12} /> Write a title. Use a short verb phrase.
        </p>
      )}
      {testOpen && (
        <div className="composer__test">
          <label className="composer__label" htmlFor={`${uid}-path`}>
            Test file
          </label>
          <input
            id={`${uid}-path`}
            className="b-input voice-agent composer__path"
            value={draft.checkPath}
            onChange={(e) => setDraft({ checkPath: e.target.value })}
            placeholder={`tests/${slug}.test.js`}
            spellCheck={false}
            autoComplete="off"
          />
          <label className="vh" htmlFor={`${uid}-code`}>
            Test code
          </label>
          <textarea
            id={`${uid}-code`}
            className="b-textarea voice-agent composer__code"
            rows={6}
            value={draft.checkCode}
            onChange={(e) => setDraft({ checkCode: e.target.value })}
            placeholder={container ? CONTAINER_PLACEHOLDER : CHECK_PLACEHOLDER}
            spellCheck={false}
          />
          <p className="composer__note">
            {container ? "A test in the test framework of this repository. The test command runs it with all other tests." : "gitring adds this test to each work copy and runs it."}
          </p>
        </div>
      )}
      <div className="composer__chips" role="group" aria-label="Task options">
        <button type="button" className="chip" aria-pressed={testOpen} onClick={() => setTestOpen(!testOpen)}>
          <Icon name={testOpen ? "check" : "plus"} size={12} />
          Test file
        </button>
        <button type="button" className="chip" {...agents.triggerProps} disabled={!canStart} title={canStart ? undefined : "This gitring has no built-in agents."}>
          <Icon name="launch" size={12} />
          {canStart ? `Agents: ${fanout}` : "No built-in agents"}
        </button>
        <button
          type="button"
          className="chip"
          aria-pressed={draft.priority === "high"}
          onClick={() => setDraft({ priority: draft.priority === "high" ? "normal" : "high" })}
          title="A high-priority task continues when its work collides with other work."
        >
          <Icon name={draft.priority === "high" ? "chevron-up" : "minus"} size={12} />
          Priority: {draft.priority === "high" ? "High" : "Normal"}
        </button>
      </div>
      {canStart ? (
        <label className="composer__start">
          <input type="checkbox" role="switch" checked={start} onChange={(e) => setStart(e.target.checked)} />
          <span>Start agents now</span>
        </label>
      ) : (
        <p className="composer__note">
          No built-in agents. <Link to="/connect">Connect your own agent</Link>.
        </p>
      )}
      {error && (
        <p className="composer__error" role="alert">
          <Icon name="cross" size={12} /> {error}
        </p>
      )}
      <div className="composer__foot">
        <Button type="submit" size="sm" variant="primary" icon={willStart ? "launch" : "plus"}>
          {willStart ? `Create and start ${fanout} ${fanout === 1 ? "agent" : "agents"}` : "Create task"}
        </Button>
        <Button size="sm" variant="ghost" onClick={collapse}>
          Close
        </Button>
      </div>
      <p className="composer__hint" id={`${uid}-help`}>
        <kbd className="b-kbd">{MOD}</kbd>
        <kbd className="b-kbd">Enter</kbd> creates · <kbd className="b-kbd">Esc</kbd> closes and keeps the draft
      </p>
      <Popover {...agents.popoverProps} label="Agents for this task" align="start" width={320}>
        <div className="launch__pop">
          <FanoutPicker fanout={fanout} setFanout={(n) => setDraft({ fanout: n })} models={models} setModels={(m) => setDraft({ models: m })} available={available} />
          <Button size="sm" variant="primary" block onClick={agents.close} data-autofocus="">
            Done
          </Button>
        </div>
      </Popover>
    </form>
  );
}
