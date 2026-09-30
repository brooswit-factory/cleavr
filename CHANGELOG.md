# Changelog

## 0.1.4

### Added

- FACTORY-496: `.github/workflows/release.yml`, a release workflow triggered by a pushed `v*` tag (or a manual `workflow_dispatch` with `dry_run: true`, which builds and uploads the zip as a workflow artifact instead of publishing). It checks the tag against the manifest/package version, runs typecheck/tests/build, stamps the git short hash into the BUILT `dist/manifest.json`'s `version_name` (the FACTORY-495 stamp — the committed `manifest.json` is untouched), zips `dist/` as `cleavr-<version>.zip` with the manifest at the zip root, and creates a GitHub Release with the matching `CHANGELOG.md` section as the release notes. Only that job gets `permissions: contents: write`; `ci.yml` stays `contents: read`. The shared logic lives in `scripts/release.mjs` (tag/version check, stamp, zip, changelog extraction) and is covered by `tests/release.test.ts`, which runs in CI on every PR without publishing anything. README gets an "Install (from a Release)" section for the zip-download path.

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
