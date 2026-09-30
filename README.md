<p align="center"><img src="assets/cleavr-logo.png" alt="Cleavr" width="240"></p>

# Cleavr

(formerly Clevr — FACTORY-509 renamed it to fix the misspelling; no
behavior changed.)

Chrome extension that slides a Butchr agent panel in from the right side of
the page you're on. Click the toolbar button to toggle it. FACTORY-336
built the shell (the panel, the options page, the agent picker). FACTORY-456
drops in a real [xterm.js](https://xtermjs.org/) terminal and wires it to
Butchr's `GET /agents/:agentKey/pty` WebSocket (`docs/pty-attach.md` in the
butchr repo is the contract this was built against).

## Authentication (or the lack of it)

FACTORY-458 originally wired a bearer-token auth channel in (the token
travelling as a second `Sec-WebSocket-Protocol` entry, since a browser
`WebSocket` constructor cannot set an `Authorization` header). **FACTORY-466
removed it**: there is no token field anywhere in this extension anymore,
no `Authorization` header on the `for-url` fetch, and no subprotocol offered
on the PTY WebSocket — `src/lib/pty/opener.ts`'s `createRealOpener` opens a
plain `new WebSocket(url)`.

Instead, Butchr authorizes Cleavr by **one hardcoded extension id**: the
daemon checks the `chrome-extension://<id>` origin it sees against a single
fixed id baked into butchr itself — there is no `BUTCHR_EXTENSION_ORIGINS`
env var or allowlist to configure any more (FACTORY-475/FACTORY-497 removed
it; an operator who still sets that variable gets a one-time warning that it
is ignored) — plus **loopback bind** (the daemon only listens on
`127.0.0.1`, so nothing off-box can reach it at all). Operator's own framing
for this change: "one should just be able to start Cleavr and work if
butchr is there."

**The tradeoff, stated plainly.** An `Origin` header is set by the browser
and not attacker-controllable from a web page, but it is not a secret, and
any other process on the same machine that can freely choose its own HTTP
headers (not a browser, not subject to the same-origin policy) could spoof
`Origin: chrome-extension://<id>` and talk to the daemon as if it were
Cleavr. This was accepted by the operator specifically for a single-user
local box, where "another process on this machine" already implies a
compromise that bearer-token auth wouldn't have meaningfully stopped either
(the token would sit in this same extension's `chrome.storage.local`,
readable by anything with equivalent access). Loopback bind is the harder
boundary here: nothing off-box gets a chance to send that Origin header at
all.

**FACTORY-478/FACTORY-480 update.** curl-with-a-hand-set-Origin and unit
tests both hid a real gap: a real MV3 extension service worker's GET to
`/resources/for-url` carries NO `Origin` header at all (measured against
headless Chrome for Testing 148 with a real built `dist/`), so the guard
above 403'd Cleavr on every real install regardless of the allowlist. The
lookup is now a `POST /resources/for-url` (page URL in a JSON body) instead
of a `GET ...?url=`, because that's the request shape Chrome DOES stamp with
`Origin` from a service worker — same strict guard, same "absent Origin is
always 403" rule, just a request shape the browser actually authenticates.
See `scripts/real-daemon-origin-test.mjs` ("Real-daemon end-to-end evidence"
below) for the real-browser proof, and butchr's own
`docs/resources-for-url.md` for the full contract.

Everything else — the connection state machine, snapshot redraw, agent
switching, keyboard isolation, reconnect/backoff — is tested against a
fake in-memory socket (`tests/pty/fake-opener.ts`) and, for headless
evidence, against a real local socket server that mimics the documented wire
shapes (see "End-to-end evidence" below).

## Install (unpacked, for development)

1. `npm install`
2. `npm run build` — bundles the extension into `dist/`.
3. In Chrome, go to `chrome://extensions`, enable "Developer mode" (top
   right), click "Load unpacked", and select the `dist/` directory.
4. **No chicken-and-egg**: `manifest.json` pins a `"key"` (a base64 RSA
   public key), so the extension id Chrome assigns is fixed and known ahead
   of any install — see "Fixed extension id" below. Butchr hardcodes that
   same id as the only allowed origin (see the butchr repo's docs), so a
   fresh install from ANY path/machine attaches with no daemon config
   needed. Nothing here ever loosens or widens that check beyond this one
   fixed id — that would defeat the entire point of it.
5. Click the Cleavr icon in the toolbar on any page to toggle the panel.
6. Right-click the Cleavr icon → Options (or find it under the extension's
   details page) to set your daemon URL — see below.

Re-run `npm run build` and click the reload icon on `chrome://extensions`
after making changes.

### Fixed extension id (manifest `"key"`)

`manifest.json`'s `"key"` field is the base64 DER-encoded RSA public key of
a keypair generated once for this repo. Chrome derives the extension id
from it deterministically: SHA-256 the DER bytes, take the first 16 bytes
of the digest, map each hex nibble `0-9a-f` to the letters `a-p`. That
computation is implemented in `scripts/extension-id.mjs` and asserted
against the documented id below by `tests/extension-id.test.ts`, so a
change to the committed key that doesn't also update the documented id
fails the test suite.

This repo's fixed extension id is:

```
geffpgminecanhmpafbliajpeleoocan
```

**Only the public key is committed.** The matching private key is not in
this repo, was never pasted into any PR/ticket/comment, and is not needed
again: Chrome only needs the public key (the manifest `"key"` field) to
compute and pin the id for an unpacked load — the private half is only
required for signing a Chrome Web Store package, which this development
extension does not do.

## Settings

Cleavr is zero-config out of the box: it always talks to its own machine's
daemon on `127.0.0.1:7717` and attaches with nothing set. The host is fixed
and not user-editable anywhere — Cleavr never connects to anything but its
own machine. The **port** is the only setting, and it's optional:

- **Daemon port** — defaults to `7717`; change it on the options page only
  if your own daemon isn't on that port (check your own workspace's
  `ENVIRONMENT.md` — never trust a port quoted in a ticket or by another
  agent, it may not be yours, and it may be stale).

There is no token field — see "Authentication (or the lack of it)" above.
No permission prompt is involved (the loopback host permission is declared
statically in `manifest.json` — see Permissions below). The options page
also has a "Test connection" button that hits the daemon and reports
whether it's reachable.

## How it works

On toolbar click, the extension injects a content script into the active
tab (if not already present) and toggles a panel that lives entirely inside
a **shadow root** — the host page's CSS cannot reach in, and the panel's CSS
cannot leak out. It slides in from the right and is resizable by dragging
its left edge (width is remembered in extension storage).

On open, the panel asks the background service worker to fetch
`POST http://127.0.0.1:<port>/resources/for-url` (page URL in a JSON body) from the
daemon, and renders one of: the page isn't a Butchr resource; Butchr knows
the resource but has no agent running on it; exactly one agent (shown
directly); or several agents (a dropdown in the daemon's own order,
remembering your last pick per resource). Whichever agent is resolved is
then attached over the PTY socket, described next.

### Where the socket lives, and why

The socket lives in the **background service worker**, not an offscreen
document. Both were engineering-merits options named by the story; the
decision came down to two things:

1. `chrome.offscreen`'s `Reason` enum (checked against
   `@types/chrome`'s current listing) has no entry that honestly describes
   "hold a persistent WebSocket open" — the closest candidates (`WORKERS`,
   `BLOBS`, …) would be a justification chosen because it's available, not
   because it's true, and Chrome Web Store policy expects the stated reason
   to be accurate.
2. Chrome's own documented MV3 behaviour resets a service worker's 30-second
   idle-eviction timer on WebSocket message traffic. This route's poll
   interval is 250ms (`docs/pty-attach.md`) — far more frequent than the
   30-second window — so an attached socket is expected to keep the worker
   alive for the life of the connection.

That expectation is not a guarantee (a browser restart, an extension
reload, or OS-level memory pressure can still evict the worker regardless of
active traffic), so the reconnect/backoff state does not depend on the
worker's own memory surviving:

- The retry timer is a `chrome.alarms` alarm, not `setTimeout` — alarms wake
  a killed service worker; timers do not survive it at all.
- The in-flight agent key and attempt count are persisted to
  `chrome.storage.session` (in-memory, per-browser-session, never synced) on
  every state change, so a worker that gets evicted and restarted mid-backoff
  resumes the SAME attempt count instead of silently restarting from attempt
  0 (see `src/background/pty-manager.ts`'s `rehydrateForRetry` and
  `src/background/wire.ts`'s alarm listener).
- The panel's own `chrome.runtime` port reconnects itself if the worker side
  disconnects (ports do not auto-reconnect in MV3); the background's own
  connection state is what actually survives, not the pipe carrying it.

### Snapshot redraw, not append

Every `TEXT` frame the daemon sends is the pane's **entire current
snapshot**, never a diff (`docs/pty-attach.md`'s "Output: a polled snapshot,
not a byte stream") — herdr has no subscribe-to-output call, so the daemon
polls and resends the whole screen whenever it changes. Writing that to
xterm.js naively would append forever and the panel would look broken
(scrolling garbage, old and new content mixed). Instead, every frame is
prefixed with `\x1b[H\x1b[2J` (cursor home + clear screen — both standard
ANSI xterm.js already implements) before being written
(`src/lib/pty/redraw.ts`), so each frame is a genuine full-screen redraw.
Covered by a headless-xterm.js test (`tests/pty/redraw.test.ts`) that
asserts two successive different snapshots do NOT leave both visible in the
buffer, and by the smoke test below over a real socket.

### Resize cannot work — and this build does not pretend it does

Butchr's route accepts a `{"type":"resize",...}` control frame but has
nothing to wire it to (no herdr call sets a pane's PTY size —
`docs/pty-attach.md`'s Resize section). This build sends that frame on
panel/window resize (via xterm's fit addon) because doing so is harmless,
but **nothing in this code depends on it reaching the agent, and there is no
test asserting it does.** Resizing the panel changes how much of the
snapshot you can see; it does **not** change the columns/rows the remote
agent's terminal actually thinks it has. A snapshot too wide for the fitted
terminal is left to xterm's own wrapping/scrollback, never re-flowed.

### Connection states

Every state below is rendered in the panel itself (a banner above the
terminal), never only in devtools:

| state | meaning | auto-retry? |
|---|---|---|
| connecting | attempting to open the socket | — |
| (attached — no banner) | live | — |
| pane went away | Butchr closed with code 4000, `"agent gone: pane no longer live"` | no (terminal) |
| agent not found | the daemon returned 404 for this key (invalid key, or no such live pane) | no (terminal) |
| rejected (401/403) | the daemon refused the connection; check its Origin allowlist | no (terminal) |
| daemon unreachable | the initial attach couldn't even be classified as 401/403/404 | yes, bounded |
| connection dropped unexpectedly | was live, then wasn't | yes, bounded |
| reconnecting (attempt N) | a bounded backoff retry is scheduled | — |
| gave up reconnecting | hit the retry cap; shows a manual "Reconnect" button | no (until pressed) |

**A browser `WebSocket` exposes no HTTP status for a failed upgrade** — only
a generic `error`/`close 1006`. So an initial-attach failure (which could be
401, 403, 404, or a genuinely unreachable daemon — all indistinguishable
over the socket alone) triggers a diagnostic plain-`fetch()` to the same URL
(`src/background/pty-manager.ts`'s `probe`), classified by that response's
status. This is best-effort: the probe is a bare GET against a WS-only
route, not a documented HTTP contract, so a response outside 401/403/404 is
treated as "unreachable" rather than guessed at further.

**Back-pressure is deliberately NOT a distinct state.** Butchr opens the
socket with a 4MB `backpressureLimit` and `closeOnBackpressureLimit: true`.
This was measured directly: a local Bun server configured identically
(same `backpressureLimit`/`closeOnBackpressureLimit` options) was driven
into back-pressure with a client that stopped draining its TCP socket, and
the resulting close was **code 1006 with an empty reason** — byte-for-byte
the same as an ordinary abnormal network drop. There is nothing on the wire
to tell the two apart, so this build folds both into one "connection
dropped unexpectedly" state rather than claiming a precision (a
"you fell behind" message) it cannot actually deliver.

Reconnect uses bounded exponential backoff (500ms, 1s, 2s, 4s, 8s, capped at
15s; `src/lib/pty/state.ts`'s `delayForAttempt`), up to 6 scheduled retries
before requiring the "Reconnect" button — an unbounded auto-retry would
otherwise risk looking like a working terminal while silently failing
forever, which the state machine deliberately never does. The attempt count
is NOT reset just because a retry briefly reaches "attached" again — only a
fresh agent pick or a manual reconnect resets it — so a connection that
flaps (opens, then drops again immediately, repeatedly) still counts toward
the cap instead of retrying forever.

### Agent switching

Picking a different agent in the dropdown tears down exactly the previous
socket and opens exactly one new one, clearing the terminal in between — no
window where two agents' output could interleave. Covered by
`tests/pty/pty-manager.test.ts` against a fake opener.

### Keyboard

Keys typed into the terminal reach the agent as raw input frames
(`term.onData`) and are stopped from bubbling to the host page's own
shortcut handlers (Jira and GitHub both bind bare letters — on **keydown,
keypress, or keyup**, depending on the site) by
`src/content/keyboard-isolation.ts`'s `installKeyboardIsolation`, which
attaches a `stopPropagation` listener for **all three** key event types on
the panel's shadow host, run during the bubble phase after xterm's own
handling. Stopping only `keydown` (an earlier version of this code) still
lets `keypress`/`keyup` bubble out and trigger a page's shortcut on those
events instead. This now includes **Escape**, which previously closed the
panel (FACTORY-336) — since an agent may legitimately bind Escape (e.g. to
cancel a prompt), it can no longer also close the panel. **The panel's close
affordances are now only the "×" button and the toolbar icon toggle.**

`tests/content/keyboard-isolation.test.ts` (jsdom) verifies, for Ctrl-C,
Ctrl-D, Tab, all four arrow keys, and Escape, across all three event types
(24 cases): the key still reaches an element inside the shadow tree (i.e.
isolation never blocks the terminal itself from seeing it) AND never
reaches a `document`-level listener. `scripts/smoke-test.mjs` additionally
confirms this in a real browser.

**Inherent limitation, not fixed here:** a host page that registers its
shortcut handler in the **capture** phase on `document` still sees the key,
because capture runs ancestor-first and nothing at the shadow host can
prevent it — this is how the DOM's capture phase works, not a defect in
this panel (the same fact is documented from the transport side in
`docs/pty-attach.md`).

### Why the fetch happens in the background

The daemon only sends CORS headers for allowlisted `chrome-extension://`
origins, not for arbitrary page origins. A content script's `fetch()` runs
subject to the host page's own CORS/CSP context, so the request is made
from the background service worker (the extension's own origin) instead,
and the result is relayed to the panel over `chrome.runtime` messaging. The
PTY socket is opened from the same background context for a stricter
reason: a WebSocket has no CORS protection at all, so a socket opened from
the content script would carry the HOST PAGE's origin (e.g. `github.com`)
and Butchr's Origin allowlist would (correctly) 403 it. Opening it from the
background gives it `Origin: chrome-extension://<id>` instead.

## Permissions, and why each one is requested

- **`activeTab`** — lets the extension inject its content script into
  whichever tab you click the toolbar button on, without needing standing
  access to every page you visit.
- **`scripting`** — required to perform that injection
  (`chrome.scripting.executeScript`) in response to the toolbar click.
- **`storage`** — persists your daemon's port, the panel's width, and
  your last-picked agent per resource, all in `chrome.storage.local`
  (never synced, never sent anywhere but the daemon you configure).
- **`alarms`** (new in FACTORY-456) — schedules the bounded reconnect
  backoff timer. `chrome.alarms`, not `setTimeout`, because an alarm can
  wake a service worker MV3 has evicted; a timer cannot (see "Where the
  socket lives" above).
- **`host_permissions` (`http://127.0.0.1/*`, required, granted at install —
  FACTORY-469)** — Cleavr only ever talks to loopback (the host is fixed and
  not user-editable), so this can be declared statically instead of
  `optional_host_permissions`: no permission prompt, no options-page visit,
  no `chrome.permissions.request()` call anywhere in this extension. A
  fresh unpacked install attaches with nothing configured.

No other permissions are requested. There is no `<all_urls>` content
script, no `tabs` permission, no `declarativeNetRequest` (tested and found
not to rewrite WebSocket upgrade headers — see FACTORY-454's own
investigation), and no remote code — everything the extension runs ships
inside the package (xterm.js and its fit addon are bundled by esbuild), as
MV3's content security policy requires.

## Tests

```
npm run typecheck   # tsc --noEmit
npm test            # vitest — adapter, URL-encoding, persistence, and PTY logic
npm run build       # bundles src/ into dist/
```

`npm test` covers, in addition to FACTORY-336's existing adapter/URL/storage
suites:

- **`tests/pty/state.test.ts`** — the pure connection state machine: every
  state in the table above, including the pane-gone close code, agent
  switching (exactly one close + one open), bounded backoff (grows then
  caps, gives up at the attempt limit), and that terminal states never
  auto-retry.
- **`tests/pty/redraw.test.ts`** — runs actual snapshot text through a real
  (headless, `@xterm/headless`) xterm.js `Terminal`: shows naive appending
  DOES accumulate (the bug this exists to prevent), that the redraw wrapper
  does NOT, that a repeated identical snapshot is idempotent, and that ANSI
  color survives the wrapper.
- **`tests/pty/opener.test.ts`** — `createRealOpener` against a fake
  `WebSocket` constructor: no subprotocol is offered at all (FACTORY-466
  dropped the bearer-token channel), and the URL matches `ptyWebSocketUrl`.
- **`tests/pty/pty-manager.test.ts`** — the imperative shell
  (`PtyConnectionManager`) against `tests/pty/fake-opener.ts`, an in-memory
  fake socket: exactly-one-socket agent switching, pane-gone with no retry
  alarm, bounded-retry exhaustion and manual reconnect, and a resize frame
  not breaking the connection (with no assertion that it reached the agent,
  per the ticket's own constraint).
- **`tests/content/keyboard-isolation.test.ts`** (jsdom) — Ctrl-C, Ctrl-D,
  Tab, all four arrow keys, and Escape, across keydown/keypress/keyup (24
  cases): each still reaches an element inside the shadow tree and never
  reaches a `document`-level listener.

CI (`.github/workflows/ci.yml`) runs `typecheck`, `test`, and `build` on
every PR.

### End-to-end evidence

`npm run smoke` builds the extension, loads it into Chrome for Testing via
Puppeteer, and drives the REAL panel/background code (not a mock) through
two phases:

1. **Panel shell**: toggling it open, the "base URL unset" message,
   drag-resize, confirming Escape no longer closes the panel (the "×"
   button does), host-page layout/keyboard isolation, zero console errors —
   the same shape of coverage FACTORY-336 had, updated for this story's
   changes.
2. **PTY connection over a real socket**: points the extension at
   `scripts/fake-pty-server.mjs` — a small local server, run as a genuine
   `ws` process, that mimics `docs/pty-attach.md`'s documented wire shapes
   (ANSI snapshot frames, a 4000 pane-gone close) and also stands in for
   `GET /resources/for-url` so the real adapter/attach path runs
   end-to-end. It asserts the real xterm.js instance (via its DOM renderer)
   actually shows the fake server's snapshot text, that two successive
   snapshots do not both remain visible (the same property
   `tests/pty/redraw.test.ts` checks at the unit level, observed here
   through a real socket and a real xterm.js instance), and that a real 4000
   close surfaces the pane-gone-specific banner text, not a generic
   "disconnected" message.

`dist-e2e/background.js` is an unmodified copy of `dist/background.js` —
since FACTORY-466 removed the bearer-token auth path there is no longer a
separate authenticated/unauthenticated opener to swap between here, so the
real, shipped opener is exercised directly against
`scripts/fake-pty-server.mjs`. Run it locally with:

```
npm run smoke
```

It is not wired into CI (it downloads/drives a full browser).
`dist-e2e/manifest.json` also adds a `content_scripts` entry scoped to
`http://127.0.0.1/*` (headless Chrome has no toolbar UI to click, so it can
never obtain a genuine `activeTab` grant). The shipped `dist/manifest.json`
already declares the required `http://127.0.0.1/*` host permission (see
Permissions above) — `dist-e2e` needs nothing extra there, only the
content_scripts entry so headless Puppeteer can get `content.js` injected
at all.

**What this does NOT exercise, stated plainly**: a real butchr daemon or a
real herdr pane. `scripts/fake-pty-server.mjs` is a hand-written stand-in
for the documented shapes, not butchr itself — see "Real-daemon end-to-end
evidence" below for that.

### Real-daemon end-to-end evidence (FACTORY-458)

**Historical — describes the bearer-token auth channel FACTORY-466 later
removed.** At the time this evidence was captured, the extension
authenticated the PTY WebSocket with a bearer token carried as a
`Sec-WebSocket-Protocol` entry (`"clevr.bearer"` + the token); this section
is kept as a record of that real-daemon test methodology, not as current
behavior. See "Authentication (or the lack of it)" above for what actually
ships now (Origin allowlist + loopback bind, no token). FACTORY-509 renamed
Clevr to Cleavr; the quoted strings below are the pre-rename literals as
they were actually observed at the time, and are deliberately NOT updated
to the new spelling.

Unlike the smoke test above, this exercised the actual shipped
`dist/background.js` (`createRealOpener`, the real `Sec-WebSocket-Protocol`
bearer channel as it existed then, `PtyConnectionManager`'s protocol
verification) against a **real butchr daemon** — origin/main at the time of
writing (`6c5f26a4`, which includes FACTORY-454/455) — and a real, live
herdr pane, not a hand-written fake server.

**Why a second, standalone daemon, not the shared one this workspace's own
`ENVIRONMENT.md` points at**: that daemon runs this whole agent fleet
(including the session that did this work) and had no
`BUTCHR_EXTENSION_TOKEN`/`BUTCHR_EXTENSION_ORIGINS` configured. Restarting a
shared daemon to add them would have interrupted every other agent currently
attached to it — the ticket's own instruction is to stop and ask rather than
touch shared infrastructure unsafely. Instead: a second, fully independent
`butchr` process, built from `origin/main` in its own throwaway git
worktree, on its own port, its own workspace root, and its own
`BUTCHR_EXTENSION_TOKEN` (reusing this same host's existing Atlassian
credentials, since a real jira-work agent needs Jira access to identify
itself), never touching the shared daemon's process, config, or port. It was
stopped and its worktree removed once evidence was captured.

**What was staffed**: a single `jira-work` rule (`query: "key =
FACTORY-336"`, an already-`Done`, unrelated ticket, so any accidental agent
action would touch nothing live) with a custom, explicit `brief` telling the
agent to call no tools and just wait for terminal input — chosen specifically
so a second, independent agent process would not act on real Jira state
while this test ran. This produced a real live herdr pane running a real
Claude session, addressable as agent key `jira-work:ptytest:FACTORY-336`.

**What was actually driven**: the built extension (`dist/`) loaded into
Chrome for Testing (`~/.cache/puppeteer/chrome`, `--headless=new
--load-extension`) via Puppeteer. The extension's own background service
worker's `chrome.storage.local` was set to the test daemon's URL/token (the
same storage shape the options page itself writes), and the real extension
id Chrome assigned was added to the test daemon's `BUTCHR_EXTENSION_ORIGINS`
before starting it. From a real extension-context page (`options.html`), a
`chrome.runtime.connect({name: "clevr:pty"})` port was opened and driven
with the exact same `{type: "attach", agentKey}` / `{type: "input", ...}`
messages `src/content/panel.ts` sends — the only substitution from the real
UI flow is that the agent key was supplied directly rather than picked from
the for-url dropdown (see "not exercised" below for why).

**What was observed** (the actual captured state sequence and frame):

```
states: idle → connecting → attached → idle (after detach)
frameCount: 1
first frame: "\x1b[H\x1b[2J\r\n...▐▛███▛█   Claude Code v2.1.251\r\n...
  Opus 5 with high effort · Claude Max\r\n...
  /tmp/f458pty/workspace/jira-work/ptytest/FACTORY-336\r\n..."
```

— a real redraw-framed (`\x1b[H\x1b[2J` prefix) ANSI snapshot of the real
pane's actual on-screen content, received over a WebSocket whose handshake
completed with `ws.protocol === "clevr.bearer"` (confirmed both through this
flow reaching `attached`, which `src/background/pty-manager.ts` only
dispatches after that exact check passes, and independently via a raw `ws`
client against the same daemon/agent key, which printed `selected protocol =
"clevr.bearer"` directly). A keystroke (`{type: "input", text: "echo
FACTORY458-PTY-SMOKE\n"}`) sent over the same port arrived at the real pane
and came back in the next redrawn snapshot containing that exact literal
text — confirmed bidirectional input, not just a one-way attach.

Separately, before the extension-driven test above, the raw
`Sec-WebSocket-Protocol` contract was also verified directly against the
same test daemon with a plain `ws` client (no extension involved): a request
with no `Origin` header got `403 origin required`; a well-formed subprotocol
list against a real, live agent key got a `101` upgrade with `ws.protocol
=== "clevr.bearer"` and a real ANSI snapshot frame.

**What this does NOT cover, stated plainly**:
- The agent key was supplied directly rather than resolved through the
  panel's own `GET /resources/for-url` dropdown. Driving that dropdown
  headlessly needs a real `activeTab` grant, which requires an actual
  toolbar-click user gesture Chrome will not synthesize — the same
  constraint `scripts/smoke-test.mjs` works around with a special
  headless-only manifest permission (see above), which was deliberately not
  done here to avoid widening the shipped extension's permissions for a
  one-off manual test. FACTORY-335/339's dropdown/for-url code itself is
  unchanged by this ticket and outside its scope.
- Only a `jira-work` resource was exercised end-to-end this way. A
  managed-session (`filesystem` provider) agent was tried first, and IS a
  genuinely live herdr pane, but turned out to be structurally invisible to
  both `GET /resources/for-url` (whose own docs restrict URL→resource
  matching to `jira-work`/`github-issue`/`github-pr`/`zendesk-ticket`) and
  to `GET /agents/:agentKey/pty` itself (`src/daemon/index.ts`'s
  `ownsRuleAgent`, which the dashboard/live-pane registry both depend on, is
  hardcoded to `resourceProvider === "jira-work"` only) — a pre-existing
  scope restriction in butchr itself, unrelated to this ticket's auth
  wiring, worth the story's awareness but not something to work around here.
- This did not exercise `github-issue`/`github-pr`/`zendesk-ticket`
  resources, for the same `ownsRuleAgent` reason above — today, apparently
  none of those are attachable via this endpoint either, only `jira-work`.
- The daemon build used was `origin/main` at the time of this work
  (`6c5f26a4`); re-verify against whatever `origin/main` is at review time
  if this evidence is being relied on later.

### Real Origin-guard regression test (FACTORY-478/FACTORY-480)

`npm run test:real-daemon` (`scripts/real-daemon-origin-test.mjs`) is an
**automated** real-browser regression test, distinct from the historical,
manual FACTORY-458 evidence above — it runs headless Chrome for Testing with
the real built extension (`dist-e2e/`) loaded, against a real, listening
HTTP server running butchr's own **unmodified** Origin guard and route code
(`../butchr/scripts/real-guard-server.ts` — see that script's own header for
exactly what is real production code and what is stubbed, and why full
daemon startup, which needs live Atlassian credentials and a herdr fleet, is
out of scope for an HTTP-header regression test). No hand-set `Origin`
header anywhere in this test — that was exactly curl's blind spot on
FACTORY-464.

It drives the extension's actual compiled `fetchResources`
(`chrome.runtime.sendMessage({type:"cleavr:fetch-resources"})`, the real
message path `src/content/panel.ts` uses), so it **fails against the old
GET-only client** — verified directly by temporarily reverting
`src/background/wire.ts` to its pre-fix GET request and re-running: the
allowlisted-origin case failed with `{"kind":"failure","failure":
{"kind":"unauthorized","status":403}}`, exactly the real-world 403 that
motivated this ticket.

Checks:
1. Real allowlisted extension id, real service-worker POST → `fetchResources`
   succeeds.
2. A raw GET from the same service-worker context still 403s even with that
   same id allowlisted (GET is kept, unchanged, for non-browser callers —
   see butchr's `docs/resources-for-url.md`).
3. A real, different (never-loaded) extension id NOT in the allowlist →
   `fetchResources` reports `unauthorized`/403.
4. The `/agents/:agentKey/pty` WebSocket upgrade, attempted from the same
   real service worker: the real guard server records the `Origin` header it
   actually saw (a browser's `WebSocket` API exposes no status/headers on a
   rejected upgrade, so this is read back server-side via a test-only
   `/__test__/ws-log` endpoint). **Measured result, resolving what FACTORY-478
   left unproven**: a real headless-Chrome WebSocket upgrade from the
   extension's service worker DOES carry `Origin: chrome-extension://<id>`.

Prerequisites: a sibling `butchr` checkout with `bun install` already run
(override the default `../butchr` path with `BUTCHR_DIR`), and this repo
built for e2e (`npm run build:e2e`, which `npm run test:real-daemon` already
does for you). Not wired into CI — same reason as the smoke test above, plus
the cross-repo checkout requirement.
