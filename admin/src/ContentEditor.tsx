import { useMemo, useRef, useState } from "react";
import type { ContentPiece, FiloDocumentJson } from "@grandtour/shared";
import { byteToStringIndex } from "@grandtour/shared";

interface Props {
  content: ContentPiece | null;
  /** Plain text being edited (decoupled from the filo doc for simple edits). */
  text: string;
  onTextChange: (t: string) => void;
}

/** Extract the audio tier segments (byte range + timing) for highlighting. */
function audioSegments(doc: FiloDocumentJson | null) {
  if (!doc) return [];
  const tier = doc.tiers.find((t) => t.id === "audio" || t.kind === "audio");
  if (!tier) return [];
  return tier.annotations
    .map((a) => ({
      start: a.start,
      end: a.end,
      startMs: Number((a.payload as any).startMs ?? 0),
      endMs: Number((a.payload as any).endMs ?? 0),
    }))
    .sort((a, b) => a.startMs - b.startMs);
}

export function ContentEditor({ content, text, onTextChange }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [nowMs, setNowMs] = useState(0);

  const doc = content?.document ?? null;
  const segments = useMemo(() => audioSegments(doc), [doc]);
  const docText = doc?.text ?? "";

  // Which segment is playing now, for highlight.
  const active = segments.find((s) => nowMs >= s.startMs && nowMs < s.endMs);

  // Build highlighted preview of the doc text.
  const preview = useMemo(() => {
    if (!doc || !active) return docText;
    const s = byteToStringIndex(docText, active.start);
    const e = byteToStringIndex(docText, active.end);
    return (
      <>
        {docText.slice(0, s)}
        <span className="hl">{docText.slice(s, e)}</span>
        {docText.slice(e)}
      </>
    );
  }, [doc, active, docText]);

  return (
    <div className="card">
      <h2>Narration</h2>

      <div className="field">
        <label>Text</label>
        <textarea
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder="Write the narration, or generate it with AI…"
        />
      </div>

      {content?.audioUrl && (
        <div className="field">
          <label>
            Audio preview{" "}
            {content.durationMs ? <span className="muted">({(content.durationMs / 1000).toFixed(1)}s)</span> : null}
          </label>
          <audio
            ref={audioRef}
            src={content.audioUrl}
            controls
            onTimeUpdate={(e) => setNowMs(e.currentTarget.currentTime * 1000)}
          />
          {doc && segments.length > 0 && (
            <div className="card" style={{ marginTop: 8 }}>
              <div className="muted" style={{ marginBottom: 4 }}>
                Aligned transcript {active ? "" : "(play to follow along)"}
              </div>
              <div>{preview}</div>
            </div>
          )}
        </div>
      )}

      {content?.provenance?.warnings?.length ? (
        <div className="field">
          <label>Generation warnings</label>
          <ul className="muted" style={{ margin: 0, paddingLeft: 16 }}>
            {content.provenance.warnings.map((w, i) => (
              <li key={i}>⚠️ {w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {content?.provenance && content.provenance.sources.length > 0 && (
        <div className="field">
          <label>Sources</label>
          <ul className="muted" style={{ margin: 0, paddingLeft: 16 }}>
            {content.provenance.sources.map((s) => (
              <li key={s.url ?? s.name}>
                {s.url ? (
                  <a href={s.url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                    {s.name}
                  </a>
                ) : (
                  s.name
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
