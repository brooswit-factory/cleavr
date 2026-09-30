// Every TEXT frame from the daemon is the pane's ENTIRE current snapshot,
// never a diff (docs/pty-attach.md in the butchr repo, "Output: a polled
// snapshot, not a byte stream"). Writing frames to xterm.js naively appends
// them one after another and the panel looks broken (old content scrolls up,
// new content is appended below it, forever). Each frame must instead be
// rendered as a full-screen redraw.
//
// `\x1b[H` moves the cursor home, `\x1b[2J` clears the whole visible screen
// — both standard ANSI/VT100 sequences xterm.js already implements, so this
// needs no xterm-specific API and works the same in the real terminal and in
// the headless one the tests use.
export function toRedrawSequence(snapshotText: string): string {
  return `\x1b[H\x1b[2J${snapshotText}`;
}
