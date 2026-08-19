import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("平台 AI 供应商删除界面", () => {
  it("在编辑供应商弹窗底部提供两次 Toast 确认的删除操作", async () => {
    const application = await readFile(join(process.cwd(), "src", "public", "app.js"), "utf8");
    const deletionStart = application.indexOf("async function deletePlatformProvider");
    const bindingStart = application.indexOf("function bindPlatformProviderActions", deletionStart);
    expect(deletionStart).toBeGreaterThan(-1);
    expect(bindingStart).toBeGreaterThan(deletionStart);
    const deletionSource = application.slice(deletionStart, bindingStart);
    expect(deletionSource.match(/if \(!await confirmToast/gu)).toHaveLength(2);
    expect(deletionSource).toContain('title: "删除供应商"');
    expect(deletionSource).toContain('title: "删除操作需要再次确认"');
    expect(deletionSource).toContain('confirmLabel: "继续删除"');
    expect(deletionSource).toContain('confirmLabel: "确认删除"');
    expect(deletionSource).toContain('/api/providers/${encodeURIComponent(item.id)}');
    expect(deletionSource).toContain('{ method: "DELETE" }');
    expect(deletionSource).toContain("await renderPlatformAiConfig();");
    expect(deletionSource).toContain("await loadModels();");
    expect(deletionSource).toContain("deleteToast(`已删除供应商“${item.name}”`);");

    const dialogStart = application.indexOf("function openProviderDialog");
    const dialogSource = application.slice(dialogStart, application.indexOf("function openModelDialog", dialogStart));
    expect(dialogSource).toContain('dangerAction: item ? { label: "删除供应商", onClick: () => deletePlatformProvider(item) } : null');
  });
});
