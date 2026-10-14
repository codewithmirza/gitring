/**
 * The replay clock: one requestAnimationFrame loop moves the wall time while the replay plays.
 *
 * React renders only when the step changes (index) or when play starts or stops. Everything that moves
 * inside a step (the effects on the map, the play head) reads the wall time in a frame callback
 * (`onFrame`) and writes transforms itself, so a frame costs no React render.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { indexAt, progressOf, retime, scheduleOf, SPEEDS, type ReplayStep, type Schedule } from "./model";

/** Longest wall step of one frame: a tab that comes back does not jump. */
const MAX_FRAME_MS = 100;

export interface ReplayClock {
  schedule: Schedule;
  /** The step that shows now (-1 during the title card). */
  index: number;
  playing: boolean;
  /** True at the end of the history. */
  ended: boolean;
  speed: number;
  /** The wall time now (ms). Read it in a frame callback; it changes without a render. */
  wall: () => number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (wall: number) => void;
  /** Go to the next (1) or the previous (-1) step, and pause. */
  step: (d: 1 | -1) => void;
  setSpeed: (speed: number) => void;
  /** Call `fn` on each frame while the replay plays, and once after each seek. */
  onFrame: (fn: (wall: number) => void) => () => void;
}

/** The nearest speed that the controls offer. */
export function nearestSpeed(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return SPEEDS.reduce((best, s) => (Math.abs(Math.log(s / n)) < Math.abs(Math.log(best / n)) ? s : best), SPEEDS[0] as number);
}

export function useReplayClock(steps: ReplayStep[], opts: { speed: number; autoplay: boolean; intro: number }): ReplayClock {
  const [speed, setSpeedState] = useState(opts.speed);
  const schedule = useMemo(() => scheduleOf(steps, speed, opts.intro), [steps, speed, opts.intro]);
  const [index, setIndex] = useState(() => indexAt(schedule, 0));
  const [playing, setPlaying] = useState(opts.autoplay);
  const [ended, setEnded] = useState(false);
  const wallRef = useRef(0);
  const scheduleRef = useRef(schedule);
  const indexRef = useRef(index);
  const endedRef = useRef(false);
  const playingRef = useRef(playing);
  const listeners = useRef(new Set<(wall: number) => void>());
  const raf = useRef(0);

  const publish = useCallback(() => {
    const s = scheduleRef.current;
    const wall = wallRef.current;
    const i = indexAt(s, wall);
    if (i !== indexRef.current) {
      indexRef.current = i;
      setIndex(i);
    }
    const done = s.starts.length > 0 && wall >= s.end - 1;
    if (done !== endedRef.current) {
      endedRef.current = done;
      setEnded(done);
    }
    listeners.current.forEach((fn) => fn(wall));
  }, []);

  // A new speed keeps the place: the same step, the same progress inside it.
  useEffect(() => {
    const prev = scheduleRef.current;
    if (prev !== schedule) {
      wallRef.current = prev.starts.length === schedule.starts.length ? retime(prev, schedule, wallRef.current) : 0;
      scheduleRef.current = schedule;
      publish();
    }
  }, [schedule, publish]);

  useEffect(() => {
    playingRef.current = playing;
    if (!playing) return;
    let last = performance.now();
    const frame = (now: number) => {
      const s = scheduleRef.current;
      wallRef.current = Math.min(s.end, wallRef.current + Math.min(MAX_FRAME_MS, Math.max(0, now - last)));
      last = now;
      publish();
      if (wallRef.current >= s.end) {
        setPlaying(false);
        return;
      }
      raf.current = requestAnimationFrame(frame);
    };
    raf.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, publish]);

  const seek = useCallback(
    (wall: number) => {
      wallRef.current = Math.max(0, Math.min(scheduleRef.current.end, wall));
      publish();
    },
    [publish],
  );

  const play = useCallback(() => {
    // Play at the end starts again from the first step.
    if (wallRef.current >= scheduleRef.current.end - 1) seek(0);
    setPlaying(true);
  }, [seek]);
  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => (playingRef.current ? pause() : play()), [pause, play]);

  const step = useCallback(
    (d: 1 | -1) => {
      setPlaying(false);
      const s = scheduleRef.current;
      const i = indexAt(s, wallRef.current);
      if (d === 1) {
        seek(i + 1 < s.starts.length ? s.starts[i + 1] : s.end);
        return;
      }
      // Back: to the start of this step, or to the step before when this one just began.
      const target = i >= 0 && progressOf(s, i, wallRef.current) > 0.15 ? i : i - 1;
      seek(target >= 0 ? s.starts[target] : 0);
    },
    [seek],
  );

  const onFrame = useCallback((fn: (wall: number) => void) => {
    listeners.current.add(fn);
    fn(wallRef.current);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const wall = useCallback(() => wallRef.current, []);

  return { schedule, index, playing, ended, speed, wall, play, pause, toggle, seek, step, setSpeed: setSpeedState, onFrame };
}
