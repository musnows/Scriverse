import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 错误详情界面", () => {
  it("将错误码、服务端状态和上游失败原因写入助手消息", async () => {
    const application = await readFile(join(process.cwd(), "src", "public", "app.js"), "utf8");
    const sendAiSource = application.slice(
      application.indexOf("async function sendAi()"),
      application.indexOf("async function streamChat(body)")
    );

    expect(application).toContain("function createClientError(payload, fallbackMessage, fallbackStatus = null)");
    expect(application).toContain("function formatAiFailureMessage(error)");
    expect(application).toContain("error.failure = typeof source.failure === \"string\" ? source.failure : undefined;");
    expect(application).toContain("error.callId = typeof source.callId === \"string\" ? source.callId : undefined;");
    expect(sendAiSource).toContain("const failureMessage = formatAiFailureMessage(error);");
    expect(application).toContain('streamError = createClientError(payload, "AI 流式调用失败", response.status);');
    expect(application).toContain('const isFailure = role === "assistant" && text.startsWith("调用失败：");');
    expect(application).toContain('message.className = `${role === "user" ? "user-message" : "assistant-message"}${isFailure ? " is-error" : ""}`;');
    expect(application).toContain('<p class="ai-error-text">${esc(text)}</p>');
  });

  it("让错误正文继承正常助手消息的字体和字号", async () => {
    const styles = await readFile(join(process.cwd(), "src", "public", "styles.css"), "utf8");

    expect(styles).toContain(".assistant-message.is-error .message-body { font-family: inherit; font-size: inherit; line-height: inherit; }");
    expect(styles).toContain(".assistant-message.is-error .ai-error-text { margin: 0; white-space: pre-wrap; font: inherit; }");
  });
});
