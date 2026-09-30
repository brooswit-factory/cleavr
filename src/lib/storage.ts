// Typed wrappers around chrome.storage.local. Cleavr only ever talks to its
// own machine's daemon on 127.0.0.1 (never user-editable), so the only
// setting worth storing is the port.

import type { ButchrResource } from "./adapter";
import { resourceKeyFor } from "./adapter";
import { DEFAULT_PORT, isValidPort } from "./url";

export interface Options {
  port: number;
}

const OPTIONS_KEY = "cleavr:options";
const WIDTH_KEY = "cleavr:panelWidth";
const AGENT_CHOICE_PREFIX = "cleavr:agentChoice:";

// FACTORY-509 renamed Clevr to Cleavr, including these storage key prefixes.
// One-time migration: copy any leftover "clevr:*" key to its "cleavr:*"
// counterpart when the new key is absent, then remove the old key. Never
// overwrites a new key that's already present.
const LEGACY_PREFIX = "clevr:";
const CURRENT_PREFIX = "cleavr:";

export async function migrateLegacyStorageKeys(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const toSet: Record<string, unknown> = {};
  const toRemove: string[] = [];
  for (const key of Object.keys(all)) {
    if (!key.startsWith(LEGACY_PREFIX)) continue;
    const newKey = CURRENT_PREFIX + key.slice(LEGACY_PREFIX.length);
    if (!(newKey in all)) {
      toSet[newKey] = all[key];
    }
    toRemove.push(key);
  }
  if (Object.keys(toSet).length > 0) await chrome.storage.local.set(toSet);
  if (toRemove.length > 0) await chrome.storage.local.remove(toRemove);
}

// Lazily kicked off by the first read in THIS module instance (background
// and content-script each get their own), and awaited by every read below,
// so a read can never race ahead of the migration it depends on — unlike a
// fire-and-forget call at import time, which had no such ordering against
// getOptions/getPanelWidth/getAgentChoice.
let migrated: Promise<void> | undefined;

function ensureMigrated(): Promise<void> {
  if (!migrated) {
    // A failed attempt must not latch: reset so the NEXT read retries the
    // migration instead of every read failing for the life of this module
    // instance over one transient chrome.storage error. This call's own
    // await still sees the rejection.
    migrated = migrateLegacyStorageKeys().catch((err) => {
      migrated = undefined;
      throw err;
    });
  }
  return migrated;
}

export const DEFAULT_OPTIONS: Options = { port: DEFAULT_PORT };

export async function getOptions(): Promise<Options> {
  await ensureMigrated();
  const data = await chrome.storage.local.get(OPTIONS_KEY);
  const stored = data[OPTIONS_KEY] as (Partial<Options> & { baseUrl?: unknown; token?: unknown }) | undefined;
  const options: Options = { port: isValidPort(stored?.port) ? stored.port : DEFAULT_PORT };
  // Purges any leftover `baseUrl`/`token` field from before this change (and
  // before FACTORY-466) by rewriting the stored entry to port only, rather
  // than just ignoring it on read.
  if (stored && ("baseUrl" in stored || "token" in stored)) {
    await chrome.storage.local.set({ [OPTIONS_KEY]: options });
  }
  return options;
}

export async function setOptions(options: Options): Promise<void> {
  await chrome.storage.local.set({ [OPTIONS_KEY]: options });
}

export async function getPanelWidth(defaultWidth: number): Promise<number> {
  // Unlike getOptions, a failed read here degrades to the given default
  // instead of propagating: the panel width is a cosmetic preference, not
  // something worth surfacing a visible failure over (FACTORY-530).
  try {
    await ensureMigrated();
    const data = await chrome.storage.local.get(WIDTH_KEY);
    const stored = data[WIDTH_KEY];
    return typeof stored === "number" && Number.isFinite(stored) ? stored : defaultWidth;
  } catch {
    return defaultWidth;
  }
}

export async function setPanelWidth(width: number): Promise<void> {
  await chrome.storage.local.set({ [WIDTH_KEY]: width });
}

export async function getAgentChoice(resource: ButchrResource): Promise<string | null> {
  // Same reasoning as getPanelWidth above: a remembered agent choice is a
  // convenience, not worth surfacing a visible failure over — degrade to
  // "no remembered choice" instead of propagating (FACTORY-530).
  try {
    await ensureMigrated();
    const key = AGENT_CHOICE_PREFIX + resourceKeyFor(resource);
    const data = await chrome.storage.local.get(key);
    const stored = data[key];
    return typeof stored === "string" ? stored : null;
  } catch {
    return null;
  }
}

export async function setAgentChoice(resource: ButchrResource, agentKey: string): Promise<void> {
  const key = AGENT_CHOICE_PREFIX + resourceKeyFor(resource);
  await chrome.storage.local.set({ [key]: agentKey });
}
