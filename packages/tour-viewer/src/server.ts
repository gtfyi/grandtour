import { INDEX_FILE, indexUrl } from "@grandtour/shared";

/**
 * Which server this page reads its content from.
 *
 * A server is any base URL that serves `grandtour.json` and the bundles it
 * points to: the site itself, a GitHub repository, someone's laptop, or the
 * authoring server. Precedence: `?server=` for this visit (shareable, never
 * saved), then the visitor's saved choice, then the page's own origin — the
 * site serves its own index, and in development Vite proxies it to the
 * authoring server. The phone keeps the same list under Tracks → Server.
 */
export const SERVER_KEY = "gt.server";
export const CONVENTIONAL_SERVER = "grandtour.fyi";

export function resolveServer(input: { param: string | null; stored: string | null; origin: string }): string {
  const param = input.param?.trim();
  if (param) return param;
  const stored = input.stored?.trim();
  if (stored) return stored;
  return input.origin;
}

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

export function currentServer(): string {
  return resolveServer({
    param: new URLSearchParams(window.location.search).get("server"),
    stored: storage()?.getItem(SERVER_KEY) ?? null,
    origin: window.location.origin,
  });
}

/** Remember a server (null = back to this site), then reopen the page without any `?server=` override. */
export function chooseServer(server: string | null): void {
  try {
    if (server?.trim()) storage()?.setItem(SERVER_KEY, server.trim());
    else storage()?.removeItem(SERVER_KEY);
  } catch { /* private mode: the choice lasts for this page only */ }
  const url = new URL(window.location.href);
  url.searchParams.delete("server");
  window.location.href = url.href;
}

/** The index a server spelling names, or null when the spelling is not a server. */
export function serverIndexUrl(server: string): string | null {
  try { return indexUrl(server); } catch { return null; }
}

/** A short label for a server: its host, plus the folder when there is one. */
export function describeServer(server: string): string {
  const url = serverIndexUrl(server);
  if (!url) return server;
  const u = new URL(url);
  const dir = u.pathname.replace(new RegExp(`/${INDEX_FILE}$`), "");
  return `${u.host}${dir}`;
}

/** True when `server` is this page's own origin (the default). */
export function isOwnOrigin(server: string): boolean {
  return serverIndexUrl(server) === serverIndexUrl(window.location.origin);
}
