// Computes a Chrome extension id from a manifest.json "key" field, using
// the same algorithm Chrome itself uses: SHA-256 of the DER-encoded public
// key (the raw bytes the base64 "key" string decodes to), take the first 16
// bytes of the digest, and map each hex nibble 0-9a-f to the letters a-p
// (0->a, 1->b, ..., 9->j, a->k, ..., f->p). This lets a pinned "key" predict
// the extension's id ahead of any install.
import { createHash } from "node:crypto";

const HEX_TO_EXT_ID = "abcdefghijklmnop";

export function extensionIdFromManifestKey(base64Key) {
  const der = Buffer.from(base64Key, "base64");
  const digest = createHash("sha256").update(der).digest();
  const first16 = digest.subarray(0, 16);
  let id = "";
  for (const byte of first16) {
    id += HEX_TO_EXT_ID[byte >> 4];
    id += HEX_TO_EXT_ID[byte & 0x0f];
  }
  return id;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url)));
  if (!manifest.key) {
    console.error('manifest.json has no "key" field');
    process.exit(1);
  }
  console.log(extensionIdFromManifestKey(manifest.key));
}
