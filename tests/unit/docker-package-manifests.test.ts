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

  it("使用无 shell 的非 root 运行层并只复制生产依赖", () => {
    const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
    const productionDependenciesStage = dockerfile.slice(
      dockerfile.indexOf("AS production-dependencies"),
      dockerfile.indexOf("AS build")
    );
    const runtimeStage = dockerfile.slice(dockerfile.indexOf("FROM ${RUNTIME_IMAGE} AS runtime"));
    const normalizedManifestCopy = productionDependenciesStage.indexOf("COPY --from=dependency-manifests");
    const productionInstall = productionDependenciesStage.indexOf("npm ci --omit=dev --ignore-scripts");
    const productionModulesCopy = runtimeStage.indexOf("COPY --from=production-dependencies /app/node_modules");
    const buildCopy = runtimeStage.indexOf("COPY --from=build /app/dist");
    const versionedManifestCopy = runtimeStage.lastIndexOf("COPY package.json package-lock.json");
    const runtimeEnv = runtimeStage.indexOf("ENV NODE_ENV=production");

    expect(normalizedManifestCopy).toBeGreaterThan(-1);
    expect(productionInstall).toBeGreaterThan(normalizedManifestCopy);
    expect(dockerfile).toMatch(/ARG RUNTIME_IMAGE=gcr\.io\/distroless\/cc-debian12:nonroot@sha256:[a-f0-9]{64}/u);
    expect(runtimeStage).toContain("FROM ${RUNTIME_IMAGE} AS runtime");
    expect(runtimeStage).not.toContain("RUN ");
    expect(runtimeStage).toContain("COPY --from=build /usr/local/bin/node /nodejs/bin/node");
    expect(productionModulesCopy).toBeGreaterThan(-1);
    expect(runtimeStage).not.toContain("COPY --chown=node:node src/public");
    expect(buildCopy).toBeGreaterThan(productionModulesCopy);
    expect(versionedManifestCopy).toBeGreaterThan(buildCopy);
    expect(runtimeEnv).toBeGreaterThan(versionedManifestCopy);
    expect(runtimeStage).toContain("USER 1000:1000");
    expect(runtimeStage).toContain('ENTRYPOINT ["/nodejs/bin/node"]');
    expect(runtimeStage).toContain("TZ=Asia/Shanghai");
  });

  it("仅由 develop Docker 工作流注入 Beta 提交版本", () => {
    const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
    const developWorkflow = readFileSync(new URL("../../.github/workflows/docker-develop.yml", import.meta.url), "utf8");
    const stableWorkflow = readFileSync(new URL("../../.github/workflows/docker-publish.yml", import.meta.url), "utf8");

    expect(dockerfile).toContain('ARG SCRIVERSE_BETA_COMMIT=""');
    expect(dockerfile).toContain('SCRIVERSE_BETA_COMMIT="${SCRIVERSE_BETA_COMMIT}"');
    expect(developWorkflow).toContain("SCRIVERSE_BETA_COMMIT=${{ steps.commit.outputs.sha }}");
    expect(stableWorkflow).not.toContain("SCRIVERSE_BETA_COMMIT");
  });
});
