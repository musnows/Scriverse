import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("平台 AI 供应商模型导入界面", () => {
  it("为启用的供应商提供获取模型按钮并反馈导入结果", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, page] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8")
    ]);
    const cardsStart = application.indexOf("function renderProviderCards");
    const actionsStart = application.indexOf("function bindPlatformProviderActions", cardsStart);
    const actionsEnd = application.indexOf("function renderTaskDefaults", actionsStart);
    expect(cardsStart).toBeGreaterThan(-1);
    expect(actionsStart).toBeGreaterThan(cardsStart);
    expect(actionsEnd).toBeGreaterThan(actionsStart);

    const cardsSource = application.slice(cardsStart, actionsStart);
    const actionsSource = application.slice(actionsStart, actionsEnd);
    expect(cardsSource).toContain('data-import-provider-models="${esc(provider.id)}"');
    expect(cardsSource).toContain(">获取模型</button>");
    expect(actionsSource).toContain('/api/providers/${encodeURIComponent(providerId)}/models/import');
    expect(actionsSource).toContain('button.textContent = "获取中"');
    expect(actionsSource).toContain("已获取 ${result.availableCount} 个模型，新增 ${result.importedCount} 个");
    expect(actionsSource).toContain("供应商列表中均已存在");
    expect(actionsSource).toContain("await renderPlatformAiConfig();");
    expect(actionsSource).toContain("await loadModels();");
    expect(actionsSource).toContain('focusTarget?.focus({ preventScroll: true });');
    expect(page).toContain("feature=ai-provider-model-import-v1");
  });
});
