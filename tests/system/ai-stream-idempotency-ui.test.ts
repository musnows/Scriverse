import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 对话流幂等前端", () => {
  it("每次发送携带请求级幂等键并在进行中冲突后恢复完整输入快照", async () => {
    const application = await readFile(join(process.cwd(), "src", "public", "app.js"), "utf8");
    const page = await readFile(join(process.cwd(), "src", "public", "index.html"), "utf8");

    expect(application).toContain("function createAiIdempotencyKey()");
    expect(application).toContain('"Idempotency-Key": idempotencyKey');
    expect(application).toContain("function captureAiPromptComposer()");
    expect(application).toContain("function restoreAiPromptComposer(snapshot)");
    expect(application).toContain("const composerSnapshot = captureAiPromptComposer();");
    expect(application).toContain('if (error?.code === "AI_CONVERSATION_RESPONSE_IN_PROGRESS")');
    expect(application).toContain("restoreAiPromptComposer(composerSnapshot);");
    expect(application).toContain('if (error?.code === "AI_IDEMPOTENT_REQUEST_IN_PROGRESS")');
    expect(application).toContain("state.aiCitations = snapshot.citations.map");
    expect(application).toContain("state.aiReferences = snapshot.references.map");
    expect(application).toContain("setAiPromptText(snapshot.text);");
    expect(application).toContain('toast("当前对话仍在生成回复，请等待完成或取消后再发送", "error")');
    expect(application).toContain('$("#ai-prompt").focus();');
    expect(application).toContain('eventName === "request_status"');
    expect(page).toContain('/app.js?v=20260814-ai-uuid-fallback-v1');
  });
});
