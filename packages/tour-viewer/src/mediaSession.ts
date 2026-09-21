/**
 * Lock-screen and headset controls — the web counterpart of the phone's
 * `NowPlayingController`. Same semantics: a tour is not a playlist, so
 * "next" skips the current story and "previous" replays it.
 */
type Action = "play" | "pause" | "nexttrack" | "previoustrack";
type Handlers = Partial<Record<Action, () => void>>;

function session(): MediaSession | null {
  return typeof navigator !== "undefined" && "mediaSession" in navigator ? navigator.mediaSession : null;
}

export function setNowPlaying(meta: { title: string; artist: string; album?: string } | null): void {
  const s = session();
  if (!s) return;
  s.metadata = meta ? new MediaMetadata({ title: meta.title, artist: meta.artist, album: meta.album ?? "GrandTour" }) : null;
}

export function setPlaybackState(state: MediaSessionPlaybackState): void {
  const s = session();
  if (s) s.playbackState = state;
}

export function setMediaHandlers(handlers: Handlers): void {
  const s = session();
  if (!s) return;
  for (const action of ["play", "pause", "nexttrack", "previoustrack"] as const) {
    try {
      s.setActionHandler(action, handlers[action] ?? null);
    } catch {
      // An action this browser does not support. Nothing to do.
    }
  }
}
