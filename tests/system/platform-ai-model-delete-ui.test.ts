import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("平台 AI 模型删除界面", () => {
  it("在编辑模型弹窗底部提供两次 Toast 确认的删除操作", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, page] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8")
    ]);

    const deletionStart = application.indexOf("async function deletePlatformModel");
    const bindingStart = application.indexOf("function bindPlatformProviderActions", deletionStart);
    expect(deletionStart).toBeGreaterThan(-1);
    expect(bindingStart).toBeGreaterThan(deletionStart);
    const deletionSource = application.slice(deletionStart, bindingStart);
    expect(deletionSource.match(/if \(!await confirmToast/gu)).toHaveLength(2);
    expect(deletionSource).toContain('title: "删除模型"');
    expect(deletionSource).toContain('title: "删除操作需要再次确认"');
    expect(deletionSource).toContain('confirmLabel: "继续删除"');
    expect(deletionSource).toContain('confirmLabel: "确认删除"');
    expect(deletionSource).toContain('/api/models/${encodeURIComponent(item.id)}');
    expect(deletionSource).toContain('{ method: "DELETE" }');
    expect(deletionSource).toContain("await renderPlatformAiConfig();");
    expect(deletionSource).toContain("await loadModels();");
    expect(deletionSource).toContain("deleteToast(`已删除模型“${item.displayName}”`);");

    const dialogStart = application.indexOf("function openModelDialog");
    const dialogSource = application.slice(dialogStart, application.indexOf("async function sendAi", dialogStart));
    expect(dialogSource).toContain('dangerAction: item ? { label: "删除模型", onClick: () => deletePlatformModel(item) } : null');
    expect(page).toContain("feature=ai-config-delete-v1");
  });
});
