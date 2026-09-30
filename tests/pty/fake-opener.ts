// In-memory PtySocketLike fake used by PtyConnectionManager tests — no real
// networking, per the ticket's "everything else is built and tested against
// a fake opener". Gives the test full control over open/message/close/error
// timing instead of racing a real socket.
import type { OpenPtySocketOptions, PtyOpener, PtySocketLike } from "../../src/lib/pty/opener";

export class FakeSocket implements PtySocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: (string | ArrayBufferLike | Blob | ArrayBufferView)[] = [];
  closed = false;
  protocol = "";

  constructor(readonly opts: OpenPtySocketOptions) {}

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  simulateOpen(): void {
    this.onopen?.();
  }

  simulateMessage(text: string): void {
    this.onmessage?.({ data: text });
  }

  simulateClose(code: number, reason: string): void {
    this.closed = true;
    this.onclose?.({ code, reason });
  }
}

export function createFakeOpener(): { opener: PtyOpener; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const opener: PtyOpener = (opts) => {
    const socket = new FakeSocket(opts);
    sockets.push(socket);
    return socket;
  };
  return { opener, sockets };
}
