import { useEffect, useState } from "react";
import { Index, type LngLat } from "@grandtour/shared";
import { AppView } from "./AppView";
import { ServerPicker } from "./ServerPicker";
import { describeServer } from "./server";
import type { Simulation } from "./simulate";

interface Props {
  server: string;
  /** The server's index, or null when the server spelling names nothing. */
  indexUrl: string | null;
  /** `?at=lat,lng` — stand somewhere without GPS. Labelled as simulated in the UI. */
  at: string | null;
  /** `?simulate=<slug>` — travel that track's route as a simulated trip. */
  simulate: Simulation | null;
}

function parseAt(at: string | null): LngLat | null {
  if (!at) return null;
  const [lat, lng] = at.split(",").map(Number);
  if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Fetch the server's index, then hand over to the app. */
export function AppLoader({ server, indexUrl, at, simulate }: Props) {
  const [index, setIndex] = useState<Index | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setError(null);
    if (!indexUrl) { setError(`"${server}" is not a server address.`); return; }
    fetch(indexUrl, { signal: abort.signal, cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not load the track list from ${describeServer(server)} (HTTP ${res.status}).`);
        return Index.parse(await res.json());
      })
      .then((data) => { if (!abort.signal.aborted) setIndex(data); })
      .catch((e) => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    return () => abort.abort();
  }, [server, indexUrl, attempt]);

  if (error) {
    return <main className="catalog">
      <h1>GrandTour</h1>
      <div role="alert" className="load-error">
        <p>{error}</p>
        <p className="muted">A server is any address that serves grandtour.json: a site, a GitHub repository, or a machine running GrandTour.</p>
        <button onClick={() => setAttempt((n) => n + 1)}>Try again</button>
      </div>
      <ServerPicker server={server} />
    </main>;
  }
  if (!index || !indexUrl) return <main className="catalog"><p role="status">Loading tracks…</p></main>;
  return <AppView index={index} indexUrl={indexUrl} server={server} fixedPos={parseAt(at)} simulate={simulate} />;
}
