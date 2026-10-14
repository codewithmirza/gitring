/**
 * The replay page: the real history of a project, played back on the map.
 * It shows the inside of gitring. Tasks appear, plans draw their course, and each conflict check shows its candidates on
 * the distance ladder with the facts, the rule, the model and the verdict. Change requests fly to their agents, tests run,
 * the merge queue gives its lease, the work composes onto main, the commit gets its why-record, and the other work moves
 * onto the new main. One plain caption for each step.
 * Address: /replay?project=<id>. For a recording: &autoplay=1&speed=<1–120>&kiosk=1 (kiosk hides the app bar and the controls; &theme=night picks a theme).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileNode } from "../../../src/core/types";
import { Button, EmptyState, ProgressRule } from "../design/components";
import { useSearchParam } from "../app/router";
import { useStore } from "../state/store";
import { isAbort } from "../state/http";
import { shortSha } from "../state/format";
import { typing } from "../app/keys";
import { loadHistory, type History } from "./replay/data";
import { buildScript, worldAt, type ReplayStep } from "./replay/model";
import { nearestSpeed, useReplayClock, type ReplayClock } from "./replay/clock";
import { ReplayMap } from "./replay/ReplayMap";
import { DetailCard, DETAIL_KINDS, Pipeline } from "./replay/Pipeline";
import { Controls } from "./replay/Controls";
import { endLine, introLine, STAGE_NAME, STAGES, type Stage } from "./replay/captions";
import { SPEEDS } from "./replay/model";
import "./replay/replay.css";

/* ───────────── constants ───────────── */

/** The title card before the first step (autoplay only). */
const INTRO_MS = 2600;
/** Without autoplay the replay opens before the first step, with the prompt to press play. */
const LEAD_MS = 500;
const NO_FILES: FileNode[] = [];

type Load = { state: "loading"; records: number } | { state: "error"; message: string } | { state: "ready"; history: History };

/* ───────────── the page ───────────── */

export function ReplayView() {
  const projectId = useStore((s) => s.projectId);
  const name = useStore((s) => s.state?.project.name ?? "the project");
  const liveFiles = useStore((s) => s.state?.files ?? NO_FILES);
  const kiosk = useSearchParam("kiosk") === "1";
  const autoplay = useSearchParam("autoplay") === "1";
  const speedParam = useSearchParam("speed");
  const [load, setLoad] = useState<Load>({ state: "loading", records: 0 });
  const [attempt, setAttempt] = useState(0);
  // The map keeps the files of main from the start of the replay: a merge during the replay does not move it.
  const files = useRef<FileNode[] | null>(null);
  if (!files.current && liveFiles.length) files.current = liveFiles;

  useEffect(() => {
    if (!projectId) return;
    const ctl = new AbortController();
    setLoad({ state: "loading", records: 0 });
    loadHistory(projectId, { signal: ctl.signal, onProgress: (records) => setLoad({ state: "loading", records }) })
      .then((history) => setLoad({ state: "ready", history }))
      .catch((e) => {
        if (!isAbort(e)) setLoad({ state: "error", message: String((e as Error)?.message ?? e) });
      });
    return () => ctl.abort();
  }, [projectId, attempt]);

  return (
    <div className={["replay", kiosk && "replay--kiosk"].filter(Boolean).join(" ")}>
      <h1 className="vh" tabIndex={-1}>
        Replay of {name}
      </h1>
      {load.state === "ready" ? (
        load.history.records.length ? (
          <Player history={load.history} files={files.current ?? liveFiles} name={name} kiosk={kiosk} autoplay={autoplay} speed={nearestSpeed(speedParam ?? (autoplay ? 10 : 5))} />
        ) : (
          <div className="replay__empty">
            <EmptyState text="This project has no history yet. Write a task and start an agent. The replay shows its work." />
          </div>
        )
      ) : load.state === "error" ? (
        <div className="replay__empty">
          <EmptyState text={`gitring could not read the history. ${load.message}`} action={<Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>} />
        </div>
      ) : (
        <div className="replay__loading" role="status">
          <span>Please wait for the history{load.records ? `: ${load.records.toLocaleString("en-US")} records` : ""}…</span>
          <ProgressRule />
        </div>
      )}
    </div>
  );
}

/* ───────────── the player and its parts ───────────── */

function Player({ history, files, name, kiosk, autoplay, speed }: { history: History; files: FileNode[]; name: string; kiosk: boolean; autoplay: boolean; speed: number }) {
  const script = useMemo(() => buildScript(history.records, history.agents), [history]);
  const clock = useReplayClock(script.steps, { speed, autoplay, intro: autoplay ? INTRO_MS : LEAD_MS });
  const world = useMemo(() => worldAt(script, clock.index), [script, clock.index]);
  const step: ReplayStep | undefined = script.steps[clock.index];
  const detail = useMemo(() => {
    for (let i = clock.index; i >= 0; i--) if (DETAIL_KINDS.has(script.steps[i].kind)) return script.steps[i];
    return undefined;
  }, [script, clock.index]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
    for (let i = 0; i <= clock.index && i < script.steps.length; i++) c[script.steps[i].stage] = (c[script.steps[i].stage] ?? 0) + 1;
    return c;
  }, [script, clock.index]);
  const previous = clock.index > 0 ? script.steps[clock.index - 1] : undefined;
  const merges = script.landings.length;

  useReplayKeys(clock);

  return (
    <>
      <div className="replay__stage">
        <ReplayMap files={files} script={script} world={world} clock={clock} focus={step?.attemptId ?? null} projectName={name} top={kiosk ? 96 : 84} />
        <div className="rp-cartouche">
          <span className="rp-cartouche__eyebrow">Replay</span>
          <span className="rp-cartouche__title">{name}</span>
          <span className="rp-cartouche__meta voice-agent">
            main {shortSha(world.mainSha)} · {world.counts.checks} checks · {world.counts.requests} change requests · {world.counts.merges} merges
          </span>
        </div>
        <TaskStrip world={world} />
        {autoplay && (
          <div className={["rp-title", clock.index >= 0 && "is-gone"].filter(Boolean).join(" ")} aria-hidden={clock.index >= 0}>
            <span className="rp-title__eyebrow">gitring · Replay</span>
            <span className="rp-title__name">{name}</span>
            <span className="rp-title__line">{introLine(script.intents.size, history.agents.length, merges)}</span>
          </div>
        )}
        {clock.ended && (
          <div className="rp-end" role="status">
            <span className="rp-title__eyebrow">End of the history</span>
            <span className="rp-end__line">{endLine(world.counts.checks, world.counts.requests, world.counts.merges)}</span>
            {!kiosk && (
              <Button variant="primary" icon="play" onClick={clock.play}>
                Play again
              </Button>
            )}
          </div>
        )}
        {history.cut && <p className="rp-cut">The history is long. The replay shows its first {history.records.length.toLocaleString("en-US")} records.</p>}
      </div>

      <div className="replay__caption" aria-live={clock.playing ? "off" : "polite"}>
        {step ? (
          <>
            {previous && (
              <p key={`p:${previous.id}`} className="rp-caption rp-caption--before">
                {previous.caption}
              </p>
            )}
            <p key={step.id} className={`rp-caption rp-caption--${step.stage}`}>
              <span className="rp-caption__stage">{STAGE_NAME[step.stage]}</span>
              <span className="rp-caption__time voice-agent">{clockText(step.at, script.start)}</span>
              <span className="rp-caption__text">{step.caption}</span>
              {step.quote && <span className="rp-caption__quote voice-agent">“{step.quote}”</span>}
            </p>
          </>
        ) : (
          <p className="rp-caption rp-caption--intro">
            <span className="rp-caption__text">{autoplay ? "The replay starts." : "Press play to see the history of this project."}</span>
          </p>
        )}
      </div>

      <aside className="replay__side" aria-label="Inside gitring">
        <Pipeline stage={step?.stage ?? null} counts={counts}>
          {detail && <DetailCard step={detail} script={script} world={world} now={detail === step} />}
        </Pipeline>
      </aside>

      {kiosk ? <KioskBar clock={clock} /> : <Controls clock={clock} steps={script.steps} label={`Place in the history of ${name}`} />}
    </>
  );
}

/** "12:03:44 · +4:31": the time of the step and the time since the first step. */
function clockText(at: number, start: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  const s = Math.max(0, Math.round((at - start) / 1000));
  const since = s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`;
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} · +${since}`;
}

function TaskStrip({ world }: { world: ReturnType<typeof worldAt> }) {
  const tasks = world.tasks.slice(-5);
  if (!tasks.length) return null;
  return (
    <ol className="rp-tasks" role="list" aria-label="Tasks">
      {tasks.map((t) => (
        <li key={t.id} className={`rp-task rp-task--${t.state}`}>
          <span className="rp-task__dot" aria-hidden="true" />
          <span className="rp-task__title voice-human">{t.title}</span>
          <span className="rp-task__state">{t.state === "merged" ? "Merged" : t.state === "working" ? "In work" : t.state === "paused" ? "Paused" : "Open"}</span>
        </li>
      ))}
    </ol>
  );
}

/** Kiosk mode: no controls, only a thin line that shows how far the replay is. */
function KioskBar({ clock }: { clock: ReplayClock }) {
  const fill = useRef<HTMLDivElement | null>(null);
  const end = clock.schedule.end;
  useEffect(
    () =>
      clock.onFrame((wall) => {
        if (fill.current) fill.current.style.transform = `scaleX(${end ? Math.min(1, wall / end) : 0})`;
      }),
    [clock.onFrame, end],
  );
  return (
    <div className="rp-kiosk-bar" aria-hidden="true">
      <div ref={fill} className="rp-kiosk-bar__fill" />
    </div>
  );
}

/** Space plays and pauses, the arrows step, Home and End jump, + and - change the speed. */
function useReplayKeys(clock: ReplayClock) {
  const ref = useRef(clock);
  ref.current = clock;
  const onKey = useCallback((e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
    if (document.querySelector("dialog[open]")) return;
    const c = ref.current;
    const onControl = (e.target as HTMLElement | null)?.closest?.("button, a, [role=slider], [role=radio]");
    if (e.key === " " && !onControl) c.toggle();
    else if (e.key === "ArrowRight" && !onControl) c.step(1);
    else if (e.key === "ArrowLeft" && !onControl) c.step(-1);
    else if (e.key === "Home" && !onControl) c.seek(0);
    else if (e.key === "End" && !onControl) c.seek(c.schedule.end);
    else if (e.key === "+" || e.key === "=") c.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(c.speed as (typeof SPEEDS)[number]) + 1)]);
    else if (e.key === "-" || e.key === "_") c.setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(c.speed as (typeof SPEEDS)[number]) - 1)]);
    else return;
    e.preventDefault();
  }, []);
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);
}
