export function versionFromTag(tag: string): string;
export function checkTagMatchesVersion(tag: string, version: string): void;
export function stampVersionName(manifestPath: string, gitHash: string): string;
export function extractChangelogSection(changelogText: string, version: string): string;
export function buildZip(srcDir: string, zipPath: string): string;
