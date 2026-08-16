import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 对话发送与终止按钮", () => {
  it("空闲时显示纸飞机并在生成期间切换为可用的终止按钮", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, page, styles] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(page).toContain('id="ai-send" class="ai-send-button" type="button" data-state="send" aria-label="发送消息" title="发送消息"');
    expect(page).toContain('class="ai-send-button-icon"');
    expect(application).toContain("function aiSendButtonIconMarkup(stateName)");
    expect(application).toContain('const stateName = sending ? "stop" : switching ? "switching" : "send";');
    expect(application).toContain("button.disabled = switching;");
    expect(application).toContain('button.classList.toggle("is-stop", sending);');
    expect(application).toContain('const label = sending ? "终止当前回复" : switching ? "正在切换对话" : "发送消息";');
    expect(styles).toContain(".ai-send-button-icon { width: 17px; height: 17px;");
    expect(styles).toContain(".ai-send-button.is-stop");
  });

  it("点击终止只取消当前页签请求并恢复重新发送能力", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, page] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8")
    ]);

    expect(application).toContain("function activateAiSendControl()");
    expect(application).toContain('cancelActiveAiRequest("用户已终止当前回复")');
    expect(application).toContain('toast("已终止当前回复，可以重新发送")');
    expect(application).toContain('$("#ai-send").addEventListener("click", activateAiSendControl);');
    expect(application).toContain("if (aiRequestManager.hasActive(tab.id)) return;");
    expect(application).toContain('request.signal.reason.message === "用户已终止当前回复"');
    expect(application).toContain('const cancelledByClient = request.signal.reason?.code === "AI_REQUEST_CANCELLED";');
    expect(application).toContain('if (code === "AI_REQUEST_CANCELLED") return "已终止";');
    expect(page).toContain("&feature=ai-send-control-v2");
  });
});
