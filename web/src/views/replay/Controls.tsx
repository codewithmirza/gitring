/**
 * The replay controls: play and pause, one step back or forward, the speed and a scrub bar.
 * The scrub bar has a tick for each step, colored by stage.
 * The play head moves in the frame callback of the clock, not by renders.
 */
import { useEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { Button, IconButton, Segmented, Tooltip } from "../../design/components";
import type { ReplayClock } from "./clock";
import { STAGE_NAME, type Stage } from "./captions";
import { SPEEDS, type ReplayStep } from "./model";

/** Tick colors by stage group (tokens of the Chart room). */
const TICK_TONE: Partial<Record<Stage, string>> = {
  check: "accent",
  request: "magenta",
  tests: "clear",
  composed: "clear",
  commit: "clear",
  replot: "caution",
};

export function Controls({ clock, steps, label }: { clock: ReplayClock; steps: ReplayStep[]; label: string }) {
  const bar = useRef<HTMLDivElement | null>(null);
  const fill = useRef<HTMLDivElement | null>(null);
  const head = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const { schedule } = clock;

  // One path per tone: thousands of steps stay one element each.
  const ticks = useMemo(() => {
    const d: Record<string, string[]> = {};
    const end = schedule.end || 1;
    steps.forEach((s, i) => {
      const tone = TICK_TONE[s.stage] ?? "ink";
      const x = ((schedule.starts[i] ?? 0) / end) * 1000;
      const h = s.weight === 3 ? 4 : s.weight === 2 ? 9 : 13;
      (d[tone] ??= []).push(`M${x.toFixed(1)} ${h}V20`);
    });
    return Object.entries(d).map(([tone, parts]) => ({ tone, d: parts.join("") }));
  }, [steps, schedule]);

  useEffect(
    () =>
      clock.onFrame((wall) => {
        const p = schedule.end ? Math.max(0, Math.min(1, wall / schedule.end)) : 0;
        if (fill.current) fill.current.style.transform = `scaleX(${p})`;
        if (head.current) head.current.style.left = `${p * 100}%`;
      }),
    [clock.onFrame, schedule.end],
  );

  const seekTo = (clientX: number) => {
    const r = bar.current?.getBoundingClientRect();
    if (!r || !r.width) return;
    clock.seek(((clientX - r.left) / r.width) * schedule.end);
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekTo(e.clientX);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) seekTo(e.clientX);
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Home") clock.seek(0);
    else if (e.key === "End") clock.seek(schedule.end);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const n = steps.length;
  const cur = steps[clock.index];
  return (
    <div className="rp-controls" role="group" aria-label="Replay controls">
      <div className="rp-controls__buttons">
        <StepButton dir={-1} onClick={() => clock.step(-1)} />
        <IconButton icon={clock.playing ? "pause" : "play"} label={clock.playing ? "Pause" : "Play"} shortcut="Space" variant="primary" onClick={clock.toggle} />
        <StepButton dir={1} onClick={() => clock.step(1)} />
      </div>
      <div
        ref={bar}
        className="rp-scrub"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={n}
        aria-valuenow={Math.max(0, clock.index + 1)}
        aria-valuetext={cur ? `Step ${clock.index + 1} of ${n}, ${STAGE_NAME[cur.stage]}: ${cur.caption}` : `Before step 1 of ${n}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
      >
        <svg className="rp-scrub__ticks" viewBox="0 0 1000 20" preserveAspectRatio="none" aria-hidden="true">
          {ticks.map((t) => (
            <path key={t.tone} className={`rp-tick rp-tick--${t.tone}`} d={t.d} />
          ))}
        </svg>
        <div className="rp-scrub__track" aria-hidden="true">
          <div ref={fill} className="rp-scrub__fill" />
        </div>
        <div ref={head} className="rp-scrub__head" aria-hidden="true" />
      </div>
      <span className="rp-controls__count voice-agent" aria-hidden="true">
        {Math.max(0, clock.index + 1)}/{n}
      </span>
      <Segmented<string>
        className="rp-controls__speed"
        label="Speed"
        value={String(clock.speed)}
        onChange={(v) => clock.setSpeed(Number(v))}
        options={SPEEDS.map((s) => ({ value: String(s), label: `${s}×`, ariaLabel: `${s} times` }))}
      />
    </div>
  );
}

/** One step back or forward: a bar and a triangle (the icon set has no step icons). */
function StepButton({ dir, onClick }: { dir: 1 | -1; onClick: () => void }) {
  const label = dir === 1 ? "Step forward" : "Step back";
  return (
    <Tooltip
      label={
        <>
          {label} <kbd className="b-kbd">{dir === 1 ? "→" : "←"}</kbd>
        </>
      }
    >
      <Button variant="ghost" className="b-iconbtn" aria-label={label} onClick={onClick}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={dir === -1 ? { transform: "scaleX(-1)" } : undefined}>
          <path d="M3.5 3.25v9.5l7-4.75Z" fill="currentColor" />
          <path d="M12.75 3.25v9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </Button>
    </Tooltip>
  );
}
