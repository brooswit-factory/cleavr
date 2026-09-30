import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildZip,
  checkTagMatchesVersion,
  extractChangelogSection,
  stampVersionName,
  versionFromTag,
} from "../scripts/release.mjs";

// FACTORY-496: covers the three release-workflow steps that don't require
// actually cutting a release — tag/version match, the build-identity stamp,
// and the zip layout — so CI catches a break on every PR, not just on a tag
// push.

const tmpDirs: string[] = [];
function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "cleavr-release-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("versionFromTag / checkTagMatchesVersion", () => {
  it("strips a leading v", () => {
    expect(versionFromTag("v0.1.3")).toBe("0.1.3");
    expect(versionFromTag("0.1.3")).toBe("0.1.3");
  });

  it("passes when the tag matches the version", () => {
    expect(() => checkTagMatchesVersion("v0.1.3", "0.1.3")).not.toThrow();
  });

  it("throws when the tag does not match the version", () => {
    expect(() => checkTagMatchesVersion("v9.9.9", "0.1.3")).toThrow(/does not match/);
  });
});

describe("stampVersionName", () => {
  it("sets version_name to <version>+<hash> without touching other fields", () => {
    const dir = makeTmpDir();
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ name: "Cleavr", version: "0.1.3", key: "abc" }));

    const stamped = stampVersionName(manifestPath, "a1b2c3d");

    expect(stamped).toBe("0.1.3+a1b2c3d");
    const written = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(written).toEqual({ name: "Cleavr", version: "0.1.3", key: "abc", version_name: "0.1.3+a1b2c3d" });
  });
});

describe("extractChangelogSection", () => {
  const changelog = [
    "# Changelog",
    "",
    "## 0.1.4",
    "",
    "### Added",
    "",
    "- something new",
    "",
    "## 0.1.3",
    "",
    "### Changed",
    "",
    "- something old",
    "",
  ].join("\n");

  it("extracts only the requested version's section", () => {
    expect(extractChangelogSection(changelog, "0.1.4")).toBe("### Added\n\n- something new");
    expect(extractChangelogSection(changelog, "0.1.3")).toBe("### Changed\n\n- something old");
  });

  it("throws when the section is missing", () => {
    expect(() => extractChangelogSection(changelog, "9.9.9")).toThrow(/no "## 9\.9\.9" section/);
  });

  it("extracts the current release's real CHANGELOG.md section", () => {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const text = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    expect(() => extractChangelogSection(text, version)).not.toThrow();
  });
});

describe("buildZip", () => {
  it("puts the source directory's contents at the zip root", () => {
    const srcDir = makeTmpDir();
    const outDir = makeTmpDir();
    writeFileSync(join(srcDir, "manifest.json"), JSON.stringify({ version: "0.1.3" }));

    const zipPath = buildZip(srcDir, join(outDir, "cleavr-0.1.3.zip"));
    const listing = execFileSync("unzip", ["-l", zipPath], { encoding: "utf8" });

    expect(listing).toContain("manifest.json");
    expect(listing).not.toContain("dist/manifest.json");
  });
});
