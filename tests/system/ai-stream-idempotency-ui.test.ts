import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 对话流幂等前端", () => {
  it("每次发送携带请求级幂等键并对进行中冲突显示明确 toast", async () => {
    const application = await readFile(join(process.cwd(), "src", "public", "app.js"), "utf8");
    const page = await readFile(join(process.cwd(), "src", "public", "index.html"), "utf8");

    expect(application).toContain("function createAiIdempotencyKey()");
    expect(application).toContain('"Idempotency-Key": idempotencyKey');
    expect(application).toContain('"AI_CONVERSATION_RESPONSE_IN_PROGRESS", "AI_IDEMPOTENT_REQUEST_IN_PROGRESS"');
    expect(application).toContain('toast("当前对话仍在生成回复，请等待完成或取消后再发送", "error")');
    expect(application).toContain('$("#ai-prompt").focus();');
    expect(application).toContain('eventName === "request_status"');
    expect(page).toContain('/app.js?v=20260812-ai-stream-idempotency-v2');
  });
});
