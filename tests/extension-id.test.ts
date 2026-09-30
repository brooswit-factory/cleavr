import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extensionIdFromManifestKey } from "../scripts/extension-id.mjs";

// FACTORY-475/477: manifest.json now pins a "key" so the extension id is
// stable ahead of any install. This is the documented id (see README.md)
// that butchr hardcodes as the one allowlisted extension origin.
const DOCUMENTED_EXTENSION_ID = "geffpgminecanhmpafbliajpeleoocan";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

describe("manifest key -> extension id", () => {
  it("manifest.json has a key", () => {
    expect(typeof manifest.key).toBe("string");
    expect(manifest.key.length).toBeGreaterThan(0);
  });

  it("hashes to the documented, fixed extension id", () => {
    expect(extensionIdFromManifestKey(manifest.key)).toBe(DOCUMENTED_EXTENSION_ID);
  });
});
