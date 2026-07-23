import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Docker 依赖清单规范化", () => {
  it("保留 Linux ARM64 干净安装所需的跨平台可选依赖", () => {
    const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8")) as {
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };

    expect(lock.packages["node_modules/@img/sharp-wasm32"]?.dependencies).toHaveProperty("@emnapi/runtime");
    expect(lock.packages["node_modules/@emnapi/runtime"]?.version).toBe("1.11.2");
    expect(lock.packages["node_modules/@emnapi/core"]?.version).toBe("1.11.2");
  });

  it("只移除会随发版变化的根包版本并固定文件时间", () => {
    const directory = mkdtempSync(join(tmpdir(), "scriverse-docker-manifests-"));
    temporaryDirectories.push(directory);
    const packagePath = join(directory, "package.json");
    const lockPath = join(directory, "package-lock.json");
    writeFileSync(packagePath, JSON.stringify({
      name: "@musnows/scriverse",
      version: "0.3.11",
      type: "module",
      dependencies: { express: "^5.1.0" }
    }));
    writeFileSync(lockPath, JSON.stringify({
      name: "@musnows/scriverse",
      version: "0.3.11",
      packages: {
        "": { name: "@musnows/scriverse", version: "0.3.11", dependencies: { express: "^5.1.0" } },
        "node_modules/express": { version: "5.1.0" }
      }
    }));

    execFileSync(process.execPath, [
      fileURLToPath(new URL("../../scripts/normalize-docker-package-manifests.mjs", import.meta.url)),
      packagePath,
      lockPath
    ]);

    expect(JSON.parse(readFileSync(packagePath, "utf8"))).toEqual({
      name: "@musnows/scriverse",
      type: "module",
      dependencies: { express: "^5.1.0" }
    });
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual({
      name: "@musnows/scriverse",
      packages: {
        "": { name: "@musnows/scriverse", dependencies: { express: "^5.1.0" } },
        "node_modules/express": { version: "5.1.0" }
      }
    });
    expect(statSync(packagePath).mtimeMs).toBe(0);
    expect(statSync(lockPath).mtimeMs).toBe(0);
  });

  it("在依赖层之后才复制含版本号的真实清单", () => {
    const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
    const runtimeStage = dockerfile.slice(dockerfile.indexOf("AS runtime"));
    const normalizedManifestCopy = runtimeStage.indexOf("COPY --from=dependency-manifests");
    const productionInstall = runtimeStage.indexOf("npm ci --omit=dev");
    const publicCopy = runtimeStage.indexOf("COPY --chown=node:node src/public");
    const buildCopy = runtimeStage.indexOf("COPY --from=build /app/dist");
    const versionedManifestCopy = runtimeStage.lastIndexOf("COPY package.json package-lock.json");

    expect(normalizedManifestCopy).toBeGreaterThan(-1);
    expect(productionInstall).toBeGreaterThan(normalizedManifestCopy);
    expect(publicCopy).toBeGreaterThan(productionInstall);
    expect(buildCopy).toBeGreaterThan(publicCopy);
    expect(versionedManifestCopy).toBeGreaterThan(buildCopy);
  });
});
