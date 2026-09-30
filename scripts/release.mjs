// Shared logic behind .github/workflows/release.yml, split out so
// tests/release.test.ts can exercise the three steps that matter most
// (tag/version match, build-identity stamp, zip layout) without actually
// cutting a release. Run directly, it's the CLI the workflow shells out to.
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export function versionFromTag(tag) {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

export function checkTagMatchesVersion(tag, version) {
  if (versionFromTag(tag) !== version) {
    throw new Error(`tag "${tag}" does not match package/manifest version "${version}"`);
  }
}

// Stamps the git short hash into the BUILT dist/manifest.json's
// version_name, so the extension card shows which build it is. Never
// touches the committed manifest.json — this is the FACTORY-495 stamp.
export function stampVersionName(manifestPath, gitHash) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version_name = `${manifest.version}+${gitHash}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.version_name;
}

// Extracts the `## <version>` section of CHANGELOG.md (up to, but not
// including, the next `## ` heading) to use as GitHub Release notes.
export function extractChangelogSection(changelogText, version) {
  const heading = `## ${version}`;
  const lines = changelogText.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no "${heading}" section`);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}

// Zips srcDir's contents (not the directory itself) so the manifest sits at
// the zip root and the result is directly "Load unpacked"-able after unzip.
export function buildZip(srcDir, zipPath) {
  const absZipPath = resolve(zipPath);
  if (existsSync(absZipPath)) rmSync(absZipPath);
  execFileSync("zip", ["-r", absZipPath, "."], { cwd: srcDir, stdio: "inherit" });
  return absZipPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "check-tag": {
        const [tag] = args;
        const { version } = JSON.parse(readFileSync("package.json", "utf8"));
        checkTagMatchesVersion(tag, version);
        console.log(`tag "${tag}" matches version "${version}"`);
        break;
      }
      case "stamp": {
        const [manifestPath, gitHash] = args;
        console.log(`stamped version_name = ${stampVersionName(manifestPath, gitHash)}`);
        break;
      }
      case "zip": {
        const [srcDir, zipPath] = args;
        console.log(`wrote ${buildZip(srcDir, zipPath)}`);
        break;
      }
      case "changelog": {
        const [version] = args;
        process.stdout.write(`${extractChangelogSection(readFileSync("CHANGELOG.md", "utf8"), version)}\n`);
        break;
      }
      default:
        console.error(`usage: release.mjs <check-tag|stamp|zip|changelog> ...`);
        process.exit(1);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
