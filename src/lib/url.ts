// Cleavr only ever talks to its own machine's daemon: the host is fixed at
// 127.0.0.1, and the port is the only thing that varies.
//
// FACTORY-478/FACTORY-480: a GET from the extension's MV3 service worker (or
// an extension page) carries NO `Origin` header — measured against headless
// Chrome for Testing 148 with a real built dist/ (see FACTORY-478's Jira
// comments). Butchr's guard requires a present, allowlisted Origin on every
// request to `/resources/for-url`, and Chrome only stamps `Origin` on a POST
// from that context — so the lookup MUST be a POST with the page URL in a
// JSON body, never a GET with it in the query string.

export const DAEMON_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7717;

export function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function daemonBaseUrl(port: number): string {
  return `http://${DAEMON_HOST}:${port}`;
}

export function forUrlEndpoint(port: number): string {
  return `${daemonBaseUrl(port)}/resources/for-url`;
}

/** `fetch()`'s second argument for the `/resources/for-url` lookup — a POST with the page URL as plain JSON, not a query string (see this file's own header for why). */
export function forUrlRequestInit(pageUrl: string): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: pageUrl }),
  };
}
