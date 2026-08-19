import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("平台 AI 流事件空闲超时设置界面", () => {
  it("展示 90 秒默认值并允许保存 30 秒至 600 秒的设置", async () => {
    const [page, application, styles] = await Promise.all([
      readFile(join(process.cwd(), "src", "public", "index.html"), "utf8"),
      readFile(join(process.cwd(), "src", "public", "app.js"), "utf8"),
      readFile(join(process.cwd(), "src", "public", "styles.css"), "utf8")
    ]);

    expect(page).toContain("feature=ai-stream-idle-timeout-v2");
    expect(application).toContain('id="platform-ai-stream-idle-timeout"');
    expect(application).toContain('min="30" max="600" step="1"');
    expect(application).toContain('settings.streamIdleTimeoutSeconds ?? 90');
    expect(application).toContain('body: { streamIdleTimeoutSeconds: Number(input.value) }');
    expect(application).toContain('toast("AI 流事件空闲超时已更新")');
    expect(styles).toContain(".platform-stream-timeout-panel");
    expect(styles).toContain(".platform-stream-timeout-field input, .platform-stream-timeout-panel .config-save-button { height: 40px; min-height: 40px; }");
  });
});
