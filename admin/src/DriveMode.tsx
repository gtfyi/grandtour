import { useEffect, useState } from "react";
import type { Track, TrackExport } from "@grandtour/shared";
import { TourView } from "@grandtour/tour-viewer";
import { api } from "./api";

/** Authoring and exported bundles use the exact same tour experience. */
export function DriveMode({ track, onClose }: { track: Track; onClose: () => void }) {
  const [bundle, setBundle] = useState<TrackExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setBundle(null);
    setError(null);
    api.previewTrack(track.id, abort.signal).then((data) => {
      if (!abort.signal.aborted) setBundle(data);
    }).catch((e) => {
      if (!abort.signal.aborted) setError(String(e));
    });
    return () => abort.abort();
  }, [track.id, revision]);

  if (bundle) return <TourView key={track.id} bundle={bundle} initialMode="simulate" onClose={onClose} />;
  return <div className="panel">
    <button className="ghost" onClick={onClose}>← Back to authoring</button>
    {error ? <div role="alert">
      <p>{error}</p>
      <button onClick={() => setRevision((r) => r + 1)}>Try again</button>
    </div> : <p role="status">Loading tour preview…</p>}
  </div>;
}
