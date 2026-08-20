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
    expect(dialogSource).toContain('name="dailyTokenQuotaEnabled"');
    expect(dialogSource).toContain('name="monthlyTokenQuotaEnabled"');
    expect(dialogSource).toContain("与单个小说额度独立");
    expect(dialogSource).toContain("额度必须设置为大于 0");
    expect(dialogSource).toContain("provider-token-quota-warning");
    expect(dialogSource).toContain("value <= 0");
    expect(dialogSource).toContain("低于每日 10,000 或每月 1,000,000 时仅提示风险");
    expect(dialogSource).toContain('dailyTokenQuota: form.get("dailyTokenQuotaEnabled") === "on" ? Number(form.get("dailyTokenQuota")) : null');
    expect(dialogSource).toContain('monthlyTokenQuota: form.get("monthlyTokenQuotaEnabled") === "on" ? Number(form.get("monthlyTokenQuota")) : null');
  });
});
