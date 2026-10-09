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

export function NewIntentDialog() {
  const { newIntent: asked } = useUi();
  const canAct = useCanAct();
  const newIntent = asked && canAct;
  const available = useStore((s) => s.state?.project.settings.agentModels ?? []);
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
  const slug = slugify(title) || "new-intent";
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
          ? [{ path: checkPath.trim() || `tests/${slug}.test.js`, content: checkCode, description: `Checks for “${title.trim()}”.` }]
          : undefined,
      });
      if (launch) await harbor().launch(intent.id, fanout, models.length ? models : undefined);
      toast({
        tone: "info",
        title: launch ? "Intent open. Attempts launched." : "Intent open",
        text: launch ? `${fanout} ${fanout === 1 ? "attempt" : "attempts"} for “${intent.title}”.` : `Launch attempts for “${intent.title}” when you are ready.`,
      });
      setTitle("");
      setGoal("");
      setCheckCode("");
      setCheckPath("");
      close();
      navigate(`/intents/${intent.id}`);
    } catch (e) {
      toast({ tone: "danger", title: "The intent was not created", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={newIntent}
      onClose={close}
      size="lg"
      title="New intent"
      description="Write the goal. Add checks that prove it. Then launch attempts."
      footer={
        <>
          <span className="b-dialog__note">
            <Kbd>Esc</Kbd> closes. Nothing is saved until you create the intent.
          </span>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button busy={busy === "create"} onClick={() => submit(false)}>
            Create intent
          </Button>
          <Button variant="primary" icon="launch" busy={busy === "launch"} onClick={() => submit(true)}>
            Create and launch
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
          <Field label="Check file" optional help="Bearing writes this test into every attempt and runs it.">
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
            <span className="b-field__help">High priority stands on (rule R5).</span>
          </div>
        </div>
        <Field label="Checks" optional help="JavaScript with the repo test harness. Without checks, Bearing runs the repo checks only.">
          <Textarea voice="agent" rows={7} value={checkCode} onChange={(e) => setCheckCode(e.target.value)} placeholder={CHECK_PLACEHOLDER} spellCheck={false} />
        </Field>
        <fieldset className="newintent__launch">
          <legend className="b-field__label">Launch</legend>
          <FanoutPicker fanout={fanout} setFanout={setFanout} models={models} setModels={setModels} available={available} />
        </fieldset>
      </form>
    </Dialog>
  );
}

const SHORTCUTS: [string[], string][] = [
  [["g", "c"], "Go to the chart"],
  [["g", "i"], "Go to the intents"],
  [["g", "l"], "Go to the logbook"],
  [["g", "k"], "Go to Connect"],
  [["g", "s"], "Go to the simulation"],
  [["g", "d"], "Go to the design system"],
  [["n"], "Write a new intent"],
  [["←", "↑", "→", "↓"], "Pan the chart (Shift: pan more)"],
  [["+", "−"], "Zoom the chart in or out"],
  [["0"], "Fit the chart"],
  [["Enter"], "Open the focused vessel or buoy"],
  [["Esc"], "Close a dialog or clear the selection"],
  [["?"], "Show these shortcuts"],
];

export function ShortcutsDialog() {
  const { shortcuts } = useUi();
  return (
    <Dialog open={shortcuts} onClose={() => setUi({ shortcuts: false })} title="Keyboard shortcuts" description="Tab moves through the rails and the vessels." dismissOnScrim>
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
      description={res ? `${res.files.length} files · +${adds} −${dels} · against the attempt's base` : "The attempt against its base commit."}
    >
      {error ? <p className="err">{error}</p> : res === null ? <ProgressRule label="Loading the diff" /> : <DiffView files={res.files} large />}
    </Dialog>
  );
}
