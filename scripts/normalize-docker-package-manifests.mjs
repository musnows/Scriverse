import { readFileSync, utimesSync, writeFileSync } from "node:fs";

const manifestPaths = process.argv.slice(2);

if (manifestPaths.length === 0) {
  console.error("Package manifest paths are required");
  process.exitCode = 1;
} else {
  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.version;

    const rootPackage = manifest.packages?.[""];
    if (rootPackage && typeof rootPackage === "object" && !Array.isArray(rootPackage)) {
      delete rootPackage.version;
    }

    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    utimesSync(manifestPath, new Date(0), new Date(0));
  }
}
