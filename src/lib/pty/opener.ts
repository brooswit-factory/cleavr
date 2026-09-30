// The injectable socket opener (ticket's "given a port and agentKey, returns
// a WebSocket-like object"). Everything in src/background that drives a
// connection is written against PtySocketLike, so it can be exercised in
// tests with a fake, and in production with the real opener below.
import { DAEMON_HOST } from "../url";

export interface PtySocketLike {
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  readonly protocol: string;
}

export interface OpenPtySocketOptions {
  port: number;
  agentKey: string;
}

export type PtyOpener = (options: OpenPtySocketOptions) => PtySocketLike;

// FACTORY-466 dropped the bearer-token auth path: the daemon now gates the
// PTY route on the Origin allowlist plus loopback bind alone, so there is
// nothing left for a WebSocket subprotocol to carry — no Authorization
// header a browser WebSocket could substitute for, no token to smuggle. The
// connection is opened with no subprotocol offered at all.
export function createRealOpener(): PtyOpener {
  return ({ port, agentKey }) => new WebSocket(ptyWebSocketUrl(port, agentKey)) as unknown as PtySocketLike;
}

export function ptyWebSocketUrl(port: number, agentKey: string): string {
  return `ws://${DAEMON_HOST}:${port}/agents/${encodeURIComponent(agentKey)}/pty`;
}

export function buildResizeControlFrame(cols: number, rows: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type: "resize", cols, rows }));
}
