// A tiny local stand-in for butchr's `GET /agents/:agentKey/pty` route,
// used ONLY for headless smoke evidence (scripts/smoke-test.mjs) — this is
// NOT a real daemon and proves nothing about FACTORY-454's auth wiring or
// about a real herdr pane. It exists to mimic the documented wire shapes
// (docs/pty-attach.md in the butchr repo) closely enough that the built
// extension's own connection/redraw code can be exercised over a real
// socket, headlessly, without a live daemon.
//
// One scenario per process instance (FAKE_PTY_SCENARIO env var, default
// "normal") rather than per-request routing: the extension's real
// ptyWebSocketUrl() only ever builds `<base>/agents/<agentKey>/pty` with no
// room for a query string, so the smoke test picks a scenario by pointing
// the extension's base URL at a freshly-spawned instance of the right kind
// instead.
//   normal      — sends a snapshot every 200ms, accepts input, ignores resize
//   pane-gone   — sends one snapshot, then closes 4000 "agent gone: pane no longer live"
//   reject      — refuses the upgrade with 403 (plain HTTP, no socket)
import { WebSocketServer } from "ws";
import http from "node:http";

const scenario = process.env.FAKE_PTY_SCENARIO ?? "normal";

// Also stands in for `POST /resources/for-url` (FACTORY-335, method changed
// to POST by FACTORY-478/FACTORY-480 — see that ticket for why a real MV3
// service-worker GET carries no Origin and the real daemon's route moved to
// a JSON-body POST) — just enough to let the smoke test drive the REAL
// panel/adapter/attach path end to end (open panel -> fetch resources ->
// single agent -> attach -> real socket), rather than only the background's
// connection manager. CORS headers are needed here (unlike the WS upgrade
// below) because a service worker fetch() to a cross-origin http(s) URL,
// unlike a WebSocket, IS subject to CORS, and a JSON body's `content-type`
// is a non-simple header value that triggers a preflight.
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST",
};

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/resources/for-url") {
    if (scenario === "reject") {
      res.writeHead(403, { ...CORS_HEADERS, "content-type": "text/plain" });
      res.end("origin not allowlisted (fake)");
      return;
    }
    void readJsonBody(req).then((body) => {
      const pageUrl = typeof body.url === "string" ? body.url : null;
      res.writeHead(200, { ...CORS_HEADERS, "content-type": "application/json" });
      res.end(
        JSON.stringify({
          url: pageUrl,
          canonicalUrl: pageUrl,
          resource: { provider: "fake", id: "smoke-test" },
          agents: [{ agentKey: "fake-agent", ruleId: "r1", pane: null, live: true, label: "Fake Agent" }],
        }),
      );
    });
    return;
  }
  if (scenario === "reject") {
    res.writeHead(403, { ...CORS_HEADERS, "content-type": "text/plain" });
    res.end("origin not allowlisted (fake)");
    return;
  }
  res.writeHead(404, CORS_HEADERS);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (scenario === "reject") {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    let n = 0;
    const send = () => {
      n += 1;
      // A real snapshot: cursor-addressed ANSI, redrawn each tick — exactly
      // the shape docs/pty-attach.md describes, not a plain-text append.
      ws.send(`\x1b[H\x1b[2J\x1b[32mtick ${n}\x1b[0m\r\nsnapshot #${n}`);
      if (scenario === "pane-gone" && n === 2) {
        ws.close(4000, "agent gone: pane no longer live");
        clearInterval(timer);
      }
    };
    send();
    const timer = setInterval(send, 200);
    ws.on("message", () => {
      // Echo-free: a real pane would apply keystrokes; this fake doesn't
      // need to for the smoke test's purposes (it only asserts frames
      // render and states transition, not agent-side echo).
    });
    ws.on("close", () => clearInterval(timer));
  });
});

const port = Number(process.env.FAKE_PTY_PORT ?? 0);
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  console.log(`FAKE_PTY_PORT=${typeof address === "object" && address ? address.port : port}`);
});
