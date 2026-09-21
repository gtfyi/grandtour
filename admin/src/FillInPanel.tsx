import { useCallback, useEffect, useState } from "react";
import type { FillInItem, Track } from "@grandtour/shared";
import { fillInItemTitle, isVocabPayload } from "@grandtour/shared";
import { api } from "./api";

/**
 * Workspace for a `kind: "fillin"` track: no map, no geometry — just the
 * track's items (vocab words or quiz questions), a bulk vocab importer, and
 * per-item TTS + publish. Quiz lists are imported via
 * server/scripts/import-quizzes.ts rather than pasted here.
 *
 * Vocab import format, one word per line, fields split on `|` or tab:
 *   word | definition | example sentence [| part of speech]
 */
export function FillInPanel({ track }: { track: Track }) {
  const [items, setItems] = useState<FillInItem[] | null>(null); // null = loading
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [wordsText, setWordsText] = useState("");

  const refresh = useCallback(async () => {
    try {
      setItems(await api.listFillInItems(track.id));
    } catch (e) {
      setError(String(e));
    }
  }, [track.id]);

  useEffect(() => {
    setItems(null);
    refresh();
  }, [refresh]);

  const run = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setBusy(label);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const importWords = useCallback(() => {
    const lines = wordsText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const words: {
      word: string;
      definition: string;
      exampleSentence: string;
      partOfSpeech?: string;
    }[] = [];
    for (const line of lines) {
      const parts = line.split(/\||\t/).map((p) => p.trim());
      if (parts.length < 3 || parts.slice(0, 3).some((p) => !p)) {
        setError(`Bad line (need "word | definition | example sentence"): ${line}`);
        return;
      }
      words.push({
        word: parts[0]!,
        definition: parts[1]!,
        exampleSentence: parts[2]!,
        partOfSpeech: parts[3] || undefined,
      });
    }
    if (words.length === 0) {
      setError("Nothing to import.");
      return;
    }
    run(`Importing ${words.length} words…`, async () => {
      await api.importVocab({
        trackId: track.id,
        source: { name: sourceTitle.trim() || "Imported word list", url: sourceUrl.trim() },
        words,
      });
      setWordsText("");
      await refresh();
    });
  }, [wordsText, sourceTitle, sourceUrl, track.id, run, refresh]);

  const generateOne = useCallback(
    (item: FillInItem) =>
      run(`Synthesizing “${fillInItemTitle(item.payload)}”…`, async () => {
        const updated = await api.generateFillInAudio(item.id);
        setItems((list) => list?.map((i) => (i.id === updated.id ? updated : i)) ?? null);
      }),
    [run],
  );

  const generateMissing = useCallback(() => {
    const missing = (items ?? []).filter((i) => !i.content?.audioUrl);
    run(`Synthesizing ${missing.length} items…`, async () => {
      // Sequential on purpose: one TTS request in flight keeps the provider
      // happy and makes a mid-list failure resumable (finished items stay).
      for (const item of missing) {
        const updated = await api.generateFillInAudio(item.id);
        setItems((list) => list?.map((i) => (i.id === updated.id ? updated : i)) ?? null);
      }
    });
  }, [items, run]);

  const setStatus = useCallback(
    (item: FillInItem, status: string) =>
      run(status === "published" ? "Publishing…" : "Unpublishing…", async () => {
        const updated = await api.setFillInItemStatus(item.id, status);
        setItems((list) => list?.map((i) => (i.id === updated.id ? updated : i)) ?? null);
      }),
    [run],
  );

  const publishReady = useCallback(() => {
    const ready = (items ?? []).filter(
      (i) => i.status !== "published" && i.content?.audioUrl,
    );
    run(`Publishing ${ready.length} items…`, async () => {
      for (const item of ready) {
        const updated = await api.setFillInItemStatus(item.id, "published");
        setItems((list) => list?.map((i) => (i.id === updated.id ? updated : i)) ?? null);
      }
    });
  }, [items, run]);

  const remove = useCallback(
    (item: FillInItem) => {
      if (!confirm(`Delete “${fillInItemTitle(item.payload)}”?`)) return;
      run("Deleting…", async () => {
        await api.deleteFillInItem(item.id);
        setItems((list) => list?.filter((i) => i.id !== item.id) ?? null);
      });
    },
    [run],
  );

  const missingAudio = (items ?? []).filter((i) => !i.content?.audioUrl).length;
  const readyToPublish = (items ?? []).filter(
    (i) => i.status !== "published" && i.content?.audioUrl,
  ).length;

  return (
    <>
      {error && <div className="error">{error}</div>}
      {busy && <div className="muted">⏳ {busy}</div>}

      <div className="card">
        <div className="toolbar" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>
            Fill-in items <span className="muted">· {items?.length ?? "…"}</span>
          </h2>
          <div className="toolbar">
            {missingAudio > 0 && (
              <button className="secondary" onClick={generateMissing} disabled={!!busy}>
                🔊 Generate {missingAudio} missing
              </button>
            )}
            {readyToPublish > 0 && (
              <button className="ok" onClick={publishReady} disabled={!!busy}>
                Publish {readyToPublish} ready
              </button>
            )}
          </div>
        </div>

        {items !== null && items.length === 0 && (
          <div className="empty">
            <div className="muted">
              No items in <b>{track.name}</b> yet — import a word list below.
            </div>
          </div>
        )}
        {items === null && <div className="muted">Loading…</div>}

        <div className="spot-list">
          {(items ?? []).slice(0, 300).map((item) => (
            <div key={item.id} className="spot-row" style={{ cursor: "default" }}>
              <div className="spot-row-main">
                <div className="spot-row-title">
                  {fillInItemTitle(item.payload)}
                  {isVocabPayload(item.payload) && item.payload.senses[0]?.partOfSpeech && (
                    <span className="muted"> · {item.payload.senses[0].partOfSpeech}</span>
                  )}
                  {isVocabPayload(item.payload) && item.payload.senses.length > 1 && (
                    <span className="muted"> · {item.payload.senses.length} senses</span>
                  )}
                </div>
                <div className="muted spot-row-sub">
                  {isVocabPayload(item.payload)
                    ? item.payload.senses[0]?.definition
                    : item.payload.answers.join(" · ")}
                </div>
                {item.content?.audioUrl && (
                  <audio src={item.content.audioUrl} controls preload="none" style={{ height: 28, marginTop: 4 }} />
                )}
              </div>
              <span className={`pill ${item.status}`}>{item.status}</span>
              {!item.content?.audioUrl && (
                <button
                  className="ghost"
                  title="Generate audio"
                  onClick={() => generateOne(item)}
                  disabled={!!busy}
                >
                  🔊
                </button>
              )}
              {item.content?.audioUrl && item.status !== "published" && (
                <button className="ghost" onClick={() => setStatus(item, "published")} disabled={!!busy}>
                  Publish
                </button>
              )}
              {item.status === "published" && (
                <button className="ghost" onClick={() => setStatus(item, "draft")} disabled={!!busy}>
                  Unpublish
                </button>
              )}
              <button
                className="ghost spot-del"
                title="Delete item"
                onClick={() => remove(item)}
                disabled={!!busy}
              >
                ✕
              </button>
            </div>
          ))}
          {items && items.length > 300 && (
            <div className="muted" style={{ padding: 8 }}>
              …and {items.length - 300} more (showing the first 300; bulk
              buttons above operate on all {items.length}).
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Import vocab list</h2>
        <div className="muted" style={{ marginBottom: 8 }}>
          One word per line: <code>word | definition | example sentence</code>
          {" "}(optional 4th field: part of speech). Tabs work too.
        </div>
        <div className="row">
          <div className="field">
            <label>Source title</label>
            <input
              placeholder="e.g. Manhattan Review SAT flashcards"
              value={sourceTitle}
              onChange={(e) => setSourceTitle(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Source URL</label>
            <input
              placeholder="https://…"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
            />
          </div>
        </div>
        <div className="field">
          <label>Words</label>
          <textarea
            rows={6}
            placeholder={"loquacious | tending to talk a great deal; talkative | She was so loquacious the meeting ran an hour long. | adjective"}
            value={wordsText}
            onChange={(e) => setWordsText(e.target.value)}
          />
        </div>
        <div className="toolbar">
          <button onClick={importWords} disabled={!wordsText.trim() || !sourceUrl.trim() || !!busy}>
            Import
          </button>
          {!sourceUrl.trim() && wordsText.trim() && (
            <span className="muted">A source URL is required — it's the item's provenance.</span>
          )}
        </div>
      </div>
    </>
  );
}
