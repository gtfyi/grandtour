import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LngLat } from "@grandtour/shared";
import { cumulativeMeters, mphToMps, pointAlong } from "@grandtour/shared";

export interface DriveState {
  playing: boolean;
  distM: number;
  totalM: number;
  pos: LngLat | null;
  headingDeg: number;
  mph: number;
}

export interface DriveControls extends DriveState {
  play: () => void;
  pause: () => void;
  toggle: () => void;
  setMph: (mph: number) => void;
  seekTo: (distM: number) => void;
  next: () => void;
  prev: () => void;
  reset: () => void;
}

/**
 * Animate a traveler along `path` at a selectable speed. Pure client-side —
 * shared by the authoring preview and the app's demos. `waypointDists` are
 * cumulative distances (m) along the path for next()/prev() to step between.
 */
export function useDriveSim(path: LngLat[], waypointDists: number[]): DriveControls {
  const cum = useMemo(() => cumulativeMeters(path), [path]);
  const totalM = cum.length ? cum[cum.length - 1]! : 0;

  const [playing, setPlaying] = useState(false);
  const [distM, setDistM] = useState(0);
  const [mph, setMphState] = useState(25);

  const distRef = useRef(0);
  const mphRef = useRef(mph);
  const lastTsRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  mphRef.current = mph;

  const commitDist = useCallback(
    (d: number) => {
      const clamped = Math.max(0, Math.min(d, totalM));
      distRef.current = clamped;
      setDistM(clamped);
      return clamped;
    },
    [totalM],
  );

  useEffect(() => {
    if (!playing) {
      lastTsRef.current = null;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    const advance = (nowMs: number) => {
      const last = lastTsRef.current;
      lastTsRef.current = nowMs;
      if (last == null) return;
      const dtSec = (nowMs - last) / 1000;
      if (dtSec <= 0) return;
      const next = distRef.current + mphToMps(mphRef.current) * dtSec;
      if (next >= totalM) {
        commitDist(totalM);
        setPlaying(false);
      } else {
        commitDist(next);
      }
    };
    const raf = (nowMs: number) => {
      advance(nowMs);
      rafRef.current = requestAnimationFrame(raf);
    };
    rafRef.current = requestAnimationFrame(raf);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing, totalM, commitDist]);

  useEffect(() => {
    lastTsRef.current = null;
    setPlaying(false);
    commitDist(0);
  }, [path, commitDist]);

  const play = useCallback(() => {
    if (distRef.current >= totalM) commitDist(0);
    setPlaying(true);
  }, [totalM, commitDist]);
  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => (playing ? pause() : play()), [playing, pause, play]);
  const seekTo = useCallback((d: number) => commitDist(d), [commitDist]);
  const reset = useCallback(() => {
    lastTsRef.current = null;
    setPlaying(false);
    commitDist(0);
  }, [commitDist]);

  const next = useCallback(() => {
    const d = distRef.current + 1;
    const target = waypointDists.find((w) => w > d);
    commitDist(target ?? totalM);
  }, [waypointDists, totalM, commitDist]);
  const prev = useCallback(() => {
    const d = distRef.current - 1;
    const before = waypointDists.filter((w) => w < d);
    commitDist(before.length ? before[before.length - 1]! : 0);
  }, [waypointDists, commitDist]);

  const { pos, headingDeg } = useMemo(() => {
    if (path.length === 0) return { pos: null as LngLat | null, headingDeg: 0 };
    const p = pointAlong(path, cum, distM);
    return { pos: p.pos, headingDeg: p.headingDeg };
  }, [path, cum, distM]);

  return {
    playing, distM, totalM, pos, headingDeg, mph,
    play, pause, toggle, setMph: setMphState, seekTo, next, prev, reset,
  };
}
