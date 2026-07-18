import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("AI 输入框引用气泡", () => {
  const runtimes: Runtime[] = [];

  afterEach(() => {
    while (runtimes.length) runtimes.pop()?.close();
  });

  it("将引用放入可编辑输入框并移除上方引用区", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "ai-mention-chip-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
    runtimes.push(runtime);

    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);

    expect(page.text).toContain('id="ai-prompt" class="ai-prompt" contenteditable="true"');
    expect(page.text).toContain('aria-label="引用角色、设定或章节"');
    expect(page.text).not.toContain('id="ai-references"');
    expect(application.text).toContain("function createAiReferenceChip(reference)");
    expect(application.text).toContain('chapter: "章节"');
    expect(application.text).toContain("volumeTitle: volume.title");
    expect(application.text).toContain("没有匹配的角色、设定或章节");
    expect(application.text).toContain("range.insertNode(createAiReferenceChip(reference));");
    expect(application.text).toContain("function clearAiPromptComposer()");
    const sendAiSource = application.text.slice(
      application.text.indexOf("async function sendAi()"),
      application.text.indexOf("async function streamChat(body)")
    );
    expect(sendAiSource).toMatch(/appendMessage\("user"[\s\S]+?clearAiPromptComposer\(\);[\s\S]+?await streamChat/u);
    expect(sendAiSource.match(/clearAiPromptComposer\(\);/gu)).toHaveLength(1);
    expect(styles.text).toContain(".ai-prompt-reference");
    expect(styles.text).not.toContain(".ai-reference-chip");
  });
});
