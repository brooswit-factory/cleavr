// A minimal in-memory stand-in for chrome.storage.local, just enough for
// the storage.ts wrappers under test.

export function installChromeStorageMock(): void {
  const store = new Map<string, unknown>();

  const local = {
    get: async (keys?: string | string[] | null) => {
      const wanted = keys === undefined || keys === null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of wanted) {
        if (store.has(key)) result[key] = store.get(key);
      }
      return result;
    },
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) {
        store.set(key, value);
      }
    },
    remove: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        store.delete(key);
      }
    },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local },
  };
}
