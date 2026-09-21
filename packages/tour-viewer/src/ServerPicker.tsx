import { useState } from "react";
import { CONVENTIONAL_SERVER, chooseServer, describeServer, isOwnOrigin, serverIndexUrl } from "./server";

/**
 * The phone's Tracks → Server list, as a form: the server in use, a field
 * for another one (a site, a GitHub repository, a machine on your tailnet),
 * and the two standing choices — this site, and grandtour.fyi.
 */
export function ServerPicker({ server }: { server: string }) {
  const [text, setText] = useState("");
  const valid = text.trim() === "" || serverIndexUrl(text.trim()) !== null;
  return <div className="sheet-group server-picker">
    <div className="sheet-row split">
      <span>Server</span>
      <span className="muted">{isOwnOrigin(server) ? "This site" : describeServer(server)}</span>
    </div>
    <form className="sheet-row" onSubmit={(e) => { e.preventDefault(); if (text.trim() && valid) chooseServer(text.trim()); }}>
      <input aria-label="Server address" placeholder="grandtour.fyi, github.com/org/repo, or http://host:8787"
        value={text} onChange={(e) => setText(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      <button disabled={!text.trim() || !valid}>Use</button>
    </form>
    {!valid && <p className="sheet-footer warn">Enter a site, a GitHub repository, or an http(s) address.</p>}
    <div className="sheet-row split">
      <button className="link-btn" disabled={isOwnOrigin(server)} onClick={() => chooseServer(null)}>Use this site</button>
      <button className="link-btn" disabled={describeServer(server) === CONVENTIONAL_SERVER} onClick={() => chooseServer(CONVENTIONAL_SERVER)}>Use {CONVENTIONAL_SERVER}</button>
    </div>
  </div>;
}
