import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeStorageMock } from "./chrome-storage-mock";
import {
  getOptions,
  setOptions,
  getPanelWidth,
  setPanelWidth,
  getAgentChoice,
  setAgentChoice,
  migrateLegacyStorageKeys,
} from "../src/lib/storage";

beforeEach(() => {
  installChromeStorageMock();
});

describe("options persistence", () => {
  it("defaults to port 7717 when nothing is stored", async () => {
    expect(await getOptions()).toEqual({ port: 7717 });
  });

  it("round-trips a saved port", async () => {
    await setOptions({ port: 9999 });
    expect(await getOptions()).toEqual({ port: 9999 });
  });

  it("lets a stored port override the default", async () => {
    await chrome.storage.local.set({ "cleavr:options": { port: 4242 } });
    expect(await getOptions()).toEqual({ port: 4242 });
  });

  it("falls back to the default port for an invalid stored port", async () => {
    await chrome.storage.local.set({ "cleavr:options": { port: 999999 } });
    expect(await getOptions()).toEqual({ port: 7717 });
  });

  it("purges a leftover baseUrl field from a pre-FACTORY-469 stored options object", async () => {
    await chrome.storage.local.set({ "cleavr:options": { baseUrl: "http://localhost:9999" } });
    expect(await getOptions()).toEqual({ port: 7717 });
    const { "cleavr:options": stored } = await chrome.storage.local.get("cleavr:options");
    expect(stored).toEqual({ port: 7717 });
    expect(stored).not.toHaveProperty("baseUrl");
  });

  it("purges a leftover token field from a pre-FACTORY-466 stored options object", async () => {
    await chrome.storage.local.set({ "cleavr:options": { baseUrl: "http://localhost:9999", token: "stale" } });
    await getOptions();
    const { "cleavr:options": stored } = await chrome.storage.local.get("cleavr:options");
    expect(stored).toEqual({ port: 7717 });
    expect(stored).not.toHaveProperty("token");
  });
});

describe("FACTORY-509 legacy clevr:* storage-key migration", () => {
  it("copies an old clevr:* key to the new cleavr:* key when the new key is absent", async () => {
    await chrome.storage.local.set({ "clevr:options": { port: 4242 } });
    await migrateLegacyStorageKeys();
    const { "cleavr:options": migrated, "clevr:options": old } = await chrome.storage.local.get([
      "cleavr:options",
      "clevr:options",
    ]);
    expect(migrated).toEqual({ port: 4242 });
    expect(old).toBeUndefined();
  });

  it("does not overwrite a cleavr:* key that's already present", async () => {
    await chrome.storage.local.set({
      "clevr:panelWidth": 111,
      "cleavr:panelWidth": 500,
    });
    await migrateLegacyStorageKeys();
    const { "cleavr:panelWidth": current } = await chrome.storage.local.get("cleavr:panelWidth");
    expect(current).toBe(500);
  });

  it("does not latch a transient migration failure — the next read retries and succeeds", async () => {
    // A fresh module instance (via resetModules + dynamic import), not the
    // one imported at the top of this file: that shared instance's lazy
    // `migrated` promise may already have resolved from an earlier test in
    // this file, which would make chrome.storage.local.get's first call
    // below hit an unrelated read instead of the migration this test means
    // to fail — this isolates a real repro of the latch bug.
    const realGet = chrome.storage.local.get.bind(chrome.storage.local);
    let calls = 0;
    (chrome.storage.local as { get: typeof chrome.storage.local.get }).get = ((...args: Parameters<typeof realGet>) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("transient chrome.storage failure"));
      return realGet(...args);
    }) as typeof chrome.storage.local.get;

    vi.resetModules();
    const fresh = await import("../src/lib/storage");

    await expect(fresh.getOptions()).rejects.toThrow("transient chrome.storage failure");
    await expect(fresh.getOptions()).resolves.toEqual({ port: 7717 });
  });
});

describe("panel width persistence", () => {
  it("falls back to the given default when nothing is stored", async () => {
    expect(await getPanelWidth(380)).toBe(380);
  });

  it("round-trips a saved width", async () => {
    await setPanelWidth(500);
    expect(await getPanelWidth(380)).toBe(500);
  });

  it("ignores a corrupted (non-numeric) stored value and falls back to the default", async () => {
    installChromeStorageMock();
    await setPanelWidth(Number.NaN);
    expect(await getPanelWidth(380)).toBe(380);
  });

  // FACTORY-530: run against the pre-fix code (no try/catch around the body
  // of getPanelWidth), this rejects instead of resolving — the panel-width
  // read is a cosmetic preference and must degrade to the given default
  // rather than propagate, unlike getOptions above.
  it("degrades to the given default when chrome.storage.local.get rejects", async () => {
    (chrome.storage.local as { get: typeof chrome.storage.local.get }).get = (() =>
      Promise.reject(new Error("storage unavailable"))) as typeof chrome.storage.local.get;
    await expect(getPanelWidth(380)).resolves.toBe(380);
  });
});

describe("per-resource agent-choice persistence", () => {
  const jiraResource = { provider: "jira", id: "PROJ-1" };
  const githubResource = { provider: "github", id: "brooswit-factory/cleavr#1" };

  it("has no remembered choice by default", async () => {
    expect(await getAgentChoice(jiraResource)).toBeNull();
  });

  it("remembers the last choice for a resource", async () => {
    await setAgentChoice(jiraResource, "a1");
    expect(await getAgentChoice(jiraResource)).toBe("a1");
  });

  it("keeps choices for different resources independent", async () => {
    await setAgentChoice(jiraResource, "a1");
    await setAgentChoice(githubResource, "a2");
    expect(await getAgentChoice(jiraResource)).toBe("a1");
    expect(await getAgentChoice(githubResource)).toBe("a2");
  });

  it("overwrites a previous choice for the same resource", async () => {
    await setAgentChoice(jiraResource, "a1");
    await setAgentChoice(jiraResource, "a2");
    expect(await getAgentChoice(jiraResource)).toBe("a2");
  });

  // FACTORY-530: run against the pre-fix code (no try/catch around the body
  // of getAgentChoice), this rejects instead of resolving — like panel
  // width, a remembered agent choice must degrade to "no remembered choice"
  // rather than propagate.
  it("degrades to null when chrome.storage.local.get rejects", async () => {
    (chrome.storage.local as { get: typeof chrome.storage.local.get }).get = (() =>
      Promise.reject(new Error("storage unavailable"))) as typeof chrome.storage.local.get;
    await expect(getAgentChoice(jiraResource)).resolves.toBeNull();
  });
});
