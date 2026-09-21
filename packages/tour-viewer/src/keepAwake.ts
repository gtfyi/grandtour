import { useEffect, useState } from "react";

/**
 * Hold a screen wake lock while a tour runs.
 *
 * This is the one place the web app cannot match the phone app: iOS stops
 * delivering location updates to a page once the screen locks, and there is
 * no background mode to ask for. Keeping the screen on is the honest
 * substitute. The lock is re-acquired whenever the page becomes visible
 * again, because the browser drops it on every tab switch.
 */
export function useKeepAwake(active: boolean): { supported: boolean; held: boolean } {
  const supported = typeof navigator !== "undefined" && "wakeLock" in navigator;
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!active || !supported) {
      setHeld(false);
      return;
    }
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled || document.visibilityState !== "visible") return;
      try {
        sentinel = await navigator.wakeLock.request("screen");
        setHeld(true);
        sentinel.addEventListener("release", () => setHeld(false));
      } catch {
        setHeld(false);
      }
    };
    const onVisible = () => { void acquire(); };

    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      sentinel?.release().catch(() => {});
      setHeld(false);
    };
  }, [active, supported]);

  return { supported, held };
}
