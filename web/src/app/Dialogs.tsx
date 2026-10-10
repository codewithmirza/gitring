import { useEffect, useState } from "react";
import { Button, CodeBlock, Dialog, DiffView, Field, Input, Kbd, ProgressRule, Segmented, Textarea, toast } from "../design/components";
import { harbor } from "../state/api";
import type { DiffResult } from "../state/api";
import { kb, slugify } from "../state/format";
import { useStore } from "../state/store";
import { useCanAct } from "../state/account";
import { FanoutPicker } from "./LaunchControl";
import { navigate } from "./router";
import { setUi, useUi } from "./ui";

const CHECK_PLACEHOLDER = `import { test, expect } from "../harness/test.js";
import worker from "../src/index.js";

test("shows the new feature", async () => {
  const res = await worker.fetch(new Request("https://shop.test/"));
  expect(await res.text()).toContain("…");
});`;

/** For projects whose checks run in a container: a test in the style of node:test (Node.js 24). */
const CONTAINER_PLACEHOLDER = `import { test } from "node:test";
import assert from "node:assert/strict";
import { feature } from "../src/feature.js";

test("does the new thing", () => {
  assert.equal(feature("input"), "expected output");
});`;

export function NewIntentDialog() {
  const { newIntent: asked } = useUi();
  const canAct = useCanAct();
  const newIntent = asked && canAct;
  const available = useStore((s) => s.state?.project.settings.agentModels ?? []);
  const container = useStore((s) => s.state?.project.settings.checks?.runner === "container");
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [checkPath, setCheckPath] = useState("");
  const [checkCode, setCheckCode] = useState("");
  const [priority, setPriority] = useState<"normal" | "high">("normal");
  const [fanout, setFanout] = useState(2);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<"create" | "launch" | null>(null);
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (newIntent) {
      setModels(available);
      setTried(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newIntent]);

  const close = () => setUi({ newIntent: false });
  const slug = slugify(title) || "new-task";
  const errTitle = tried && !title.trim() ? "Write a title. Use a short verb phrase." : undefined;
  const errGoal = tried && !goal.trim() ? "Write the goal in one or two sentences." : undefined;

  const submit = async (launch: boolean) => {
    setTried(true);
    if (!title.trim() || !goal.trim()) return;
    setBusy(launch ? "launch" : "create");
    try {
      const intent = await harbor().createIntent({
        title: title.trim(),
        goal: goal.trim(),
        priority,
        checks: checkCode.trim()
          ? [{ path: checkPath.trim() || `tests/${slug}.test.js`, content: checkCode, description: `Tests for “${title.trim()}”.` }]
          : undefined,
      });
      if (launch) await harbor().launch(intent.id, fanout, models.length ? models : undefined);
      toast({
        tone: "info",
        title: launch ? "Task open. Agents start." : "Task open",
        text: launch ? `${fanout} ${fanout === 1 ? "agent" : "agents"} for “${intent.title}”.` : `Start agents for “${intent.title}” when you are ready.`,
      });
      setTitle("");
      setGoal("");
      setCheckCode("");
      setCheckPath("");
      close();
      navigate(`/tasks/${intent.id}`);
    } catch (e) {
      toast({ tone: "danger", title: "The task was not created", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={newIntent}
      onClose={close}
      size="lg"
      title="New task"
      description="Write the goal. Add tests that prove it. Then start agents."
      footer={
        <>
          <span className="b-dialog__note">
            <Kbd>Esc</Kbd> closes. Nothing is saved until you create the task.
          </span>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button busy={busy === "create"} onClick={() => submit(false)}>
            Create task
          </Button>
          <Button variant="primary" icon="launch" busy={busy === "launch"} onClick={() => submit(true)}>
            Create and start agents
          </Button>
        </>
      }
    >
      <form
        className="newintent"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(true);
        }}
      >
        <Field label="Title" error={errTitle} help="Your words. Agents read the title and the goal as the source of the work.">
          <Input
            className="voice-human newintent__title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Show the stock count on each book"
            autoComplete="off"
            data-autofocus
          />
        </Field>
        <Field label="Goal" error={errGoal} help="One or two sentences. Say what done looks like.">
          <Textarea
            voice="human"
            rows={3}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Show “In stock” or “Sold out” under each price. Read the count from src/products.js."
          />
        </Field>
        <div className="newintent__row">
          <Field label="Test file" optional help="gitring adds this test to each work copy and runs it.">
            <Input className="voice-agent" value={checkPath} onChange={(e) => setCheckPath(e.target.value)} placeholder={`tests/${slug}.test.js`} spellCheck={false} />
          </Field>
          <div className="b-field">
            <span className="b-field__label" id="prio-label">
              Priority
            </span>
            <Segmented
              label="Priority"
              value={priority}
              onChange={setPriority}
              size="md"
              options={[
                { value: "normal", label: "Normal" },
                { value: "high", label: "High" },
              ]}
            />
            <span className="b-field__help">A high-priority task continues when its work collides with other work.</span>
          </div>
        </div>
        <Field
          label="Test"
          optional
          help={
            container
              ? "A test in the test framework of this repository. gitring adds it to each work copy. The test command runs it with all other tests."
              : "JavaScript for the gitring test runner. Without a test, gitring runs only the tests of the repository."
          }
        >
          <Textarea voice="agent" rows={7} value={checkCode} onChange={(e) => setCheckCode(e.target.value)} placeholder={container ? CONTAINER_PLACEHOLDER : CHECK_PLACEHOLDER} spellCheck={false} />
        </Field>
        <fieldset className="newintent__launch">
          <legend className="b-field__label">Agents</legend>
          <FanoutPicker fanout={fanout} setFanout={setFanout} models={models} setModels={setModels} available={available} />
        </fieldset>
      </form>
    </Dialog>
  );
}

const SHORTCUTS: [string[], string][] = [
  [["g", "o"], "Go to the overview"],
  [["g", "t"], "Go to the tasks"],
  [["g", "h"], "Go to the history"],
  [["g", "k"], "Go to Connect"],
  // Development builds only (the design page does not exist in production).
  ...(import.meta.env.DEV ? ([[["g", "d"], "Go to the design page"]] as [string[], string][]) : []),
  [["n"], "Write a new task"],
  [["←", "↑", "→", "↓"], "Move the map (Shift: move more)"],
  [["+", "−"], "Zoom the map in or out"],
  [["0"], "Fit the map"],
  [["Enter"], "Open the focused agent or change request"],
  [["Esc"], "Close a dialog or clear the selection"],
  [["?"], "Show these shortcuts"],
];

export function ShortcutsDialog() {
  const { shortcuts } = useUi();
  return (
    <Dialog open={shortcuts} onClose={() => setUi({ shortcuts: false })} title="Keyboard shortcuts" description="Tab moves through the lists and the agents." dismissOnScrim>
      <dl className="shortcuts">
        {SHORTCUTS.map(([keys, text]) => (
          <div key={text} className="shortcuts__row">
            <dt>
              {keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

export function FileDrawer() {
  const { file } = useUi();
  const mainSha = useStore((s) => s.state?.project.mainSha ?? "");
  const size = useStore((s) => s.state?.files.find((f) => f.path === file?.path)?.size);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return;
    setText(null);
    setError(null);
    harbor()
      .file(file.ref, file.path)
      .then((t) => setText(typeof t === "string" ? t : JSON.stringify(t, null, 2)))
      .catch((e: Error) => setError(e.message));
  }, [file, mainSha]);
  return (
    <Dialog
      open={Boolean(file)}
      onClose={() => setUi({ file: null })}
      drawer
      title={<span className="voice-agent">{file?.path}</span>}
      description={
        <>
          {file?.ref === "main" ? `main ${mainSha.slice(0, 7)}` : file?.ref.slice(0, 7)}
          {size !== undefined ? ` · ${kb(size)}` : ""} · read only
        </>
      }
    >
      {error ? <p className="err">{error}</p> : text === null ? <ProgressRule label="Loading the file" /> : <CodeBlock code={text} label={file?.path} copyLabel="Copy file" />}
    </Dialog>
  );
}

export function DiffDrawer() {
  const { diff } = useUi();
  const [res, setRes] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!diff) return;
    setRes(null);
    setError(null);
    harbor()
      .attemptDiff(diff.attemptId)
      .then(setRes)
      .catch((e: Error) => setError(e.message));
  }, [diff]);
  const adds = res?.files.reduce((s, f) => s + f.additions, 0) ?? 0;
  const dels = res?.files.reduce((s, f) => s + f.deletions, 0) ?? 0;
  return (
    <Dialog
      open={Boolean(diff)}
      onClose={() => setUi({ diff: null })}
      drawer
      title={
        <>
          Diff of <span className="voice-agent">{diff?.title}</span>
        </>
      }
      description={res ? `${res.files.length} files · +${adds} −${dels} · against the base of the work copy` : "The work copy against its base commit."}
    >
      {error ? <p className="err">{error}</p> : res === null ? <ProgressRule label="Loading the diff" /> : <DiffView files={res.files} large />}
    </Dialog>
  );
}
