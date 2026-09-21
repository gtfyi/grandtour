import { useEffect, useRef, useState } from "react";
import type { LngLat } from "@grandtour/shared";

export interface GeoState {
  pos: LngLat | null;
  courseDeg: number | null;
  /** Ground speed in m/s when the fix carries one; null otherwise (the phone's -1). */
  speedMps: number | null;
  /** When the fix was taken, ms since the epoch. */
  at: number;
  /** True once the browser has explicitly denied permission. */
  denied: boolean;
  /** True while waiting on the first fix. */
  locating: boolean;
  error: string | null;
}

/**
 * Wraps `navigator.geolocation.watchPosition`, active only while `enabled`.
 * Mirrors iOS's `location.denied` framing in ContentView.swift so the
 * viewer can show the same "enable location" messaging.
 */
export function useGeolocation(enabled: boolean): GeoState {
  const [state, setState] = useState<GeoState>({
    pos: null,
    courseDeg: null,
    speedMps: null,
    at: 0,
    denied: false,
    locating: false,
    error: null,
  });
  const watchIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (watchIdRef.current != null) navigator.geolocation?.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
      setState((s) => ({ ...s, locating: false }));
      return;
    }
    if (!navigator.geolocation) {
      setState((s) => ({ ...s, error: "Geolocation isn't available in this browser." }));
      return;
    }
    setState((s) => ({ ...s, locating: true, error: null }));
    watchIdRef.current = navigator.geolocation.watchPosition(
      (p) => {
        setState({
          pos: { lat: p.coords.latitude, lng: p.coords.longitude },
          courseDeg: p.coords.heading != null && !Number.isNaN(p.coords.heading) ? p.coords.heading : null,
          speedMps: p.coords.speed != null && p.coords.speed >= 0 ? p.coords.speed : null,
          at: p.timestamp,
          denied: false,
          locating: false,
          error: null,
        });
      },
      (err) => {
        setState((s) => ({
          ...s,
          locating: false,
          denied: err.code === err.PERMISSION_DENIED,
          error: err.message,
        }));
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 },
    );
    return () => {
      if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    };
  }, [enabled]);

  return state;
}
