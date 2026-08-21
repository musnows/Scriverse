import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

const mainPackageUrl = new URL("../../package.json", import.meta.url);
const demoCoversUrl = new URL("../demo-covers/", import.meta.url);

export async function readMainVersion() {
  const packageJson = JSON.parse(await readFile(mainPackageUrl, "utf8"));
  const version = String(packageJson.version ?? "").trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error("Main package version is invalid.");
  return version;
}

export async function readDemoCoverVersions() {
  const entries = await readdir(demoCoversUrl);
  const versions = {};
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".webp")) continue;
    const id = entry.slice(0, -".webp".length);
    const bytes = await readFile(new URL(entry, demoCoversUrl));
    versions[id] = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  }
  return versions;
}

export function versionModuleSource(version, coverVersions = {}) {
  return `export const DEMO_VERSION = ${JSON.stringify(version)};\nexport const DEMO_COVER_VERSIONS = ${JSON.stringify(coverVersions)};\n`;
}

export function versionedDemoAdapterSource(source, version) {
  return source.replace(
    '"./demo-version.js"',
    `"./demo-version.js?v=${encodeURIComponent(version)}"`
  );
}

export function demoAssetVersion(source, version) {
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 8);
  return `${version}-${digest}`;
}

export function demoCoverCacheControl() {
  return "public, max-age=31536000, immutable";
}
