# Changelog

## 0.1.3

### Changed

- FACTORY-544: hardening before the repo goes public. `.gitignore` now also ignores `*.pem` and `.env*` (so a signing key or env file can't be committed by accident), and the CI workflow declares `permissions: contents: read` explicitly. No extension behavior change; the version bump is for the changelog gate.

## 0.1.2

### Added

- Branding: the Cleavr icon in `manifest.json` (16/32/48/128, extension card and toolbar) and the Cleavr logo on the options page and at the top of the README. Assets live in `assets/` and the build copies them into `dist/`. The extension id and `"key"` are unchanged. Loading this build needs one card reload.

## 0.1.1

### Changed

- FACTORY-509: renamed the extension from Clevr to Cleavr everywhere (package
  metadata, manifest, message types, DOM ids, storage-key prefix, docs). A
  one-time migration copies any leftover `clevr:*` `chrome.storage.local` key
  to its `cleavr:*` counterpart, then removes the old key, lazily on first
  storage read in each context. The extension id and `manifest.json`'s
  `"key"` are unchanged.
