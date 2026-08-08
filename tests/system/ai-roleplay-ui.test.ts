import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 角色扮演界面", () => {
  it("允许为当前对话选择角色卡并展示受限记忆模式", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, page, styles] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(page).toContain('<option value="roleplay">角色扮演</option>');
    expect(page).toContain('id="ai-roleplay-character" class="ai-roleplay-character hidden"');
    expect(page).toContain("选择角色卡");
    expect(application).toContain("与 ${String(state.aiRoleplayCharacter.name)} 角色开始对话……");
    expect(application).toContain("/roleplay`");
    expect(application).toContain("对话开始后不能切换任务类型");
    expect(application).toContain('$("#ai-task").disabled = state.aiPromptSent;');
    expect(application).toContain('$("#ai-scope").disabled = roleplaySelected || state.aiPromptSent;');
    expect(application).toContain("对话开始后不能切换上下文引用");
    expect(application).toContain("当前对话已经开始，请新建对话后再切换任务类型");
    expect(application).toContain("角色扮演模式只使用角色自身的记忆");
    expect(application).toContain("/task-type`");
    expect(application).toContain("/context-scope`");
    expect(application).toContain("if (state.aiPromptSent) {");
    expect(application).toContain("state.aiContextScope ?? { type: \"none\" }");
    expect(application).toContain("await persistAiConversationContextScope(requestScope.conversationScope);");
    expect(application).toContain("mergeAiReferenceScope(conversationScope, state.aiReferences)");
    expect(application).toContain("Agent 只能查询与该角色自身有关的记忆");
    expect(application).toContain("recall_self: \"回忆自身\"");
    expect(application).toContain("recall_relationship: \"回忆人物关系\"");
    expect(application).toContain("function syncAiTaskOptions()");
    expect(application).toContain('const taskType = roleplaySelected ? "chat" : selectedTaskType;');
    expect(styles).toContain(".prompt-options .ai-roleplay-character { min-width: 0; }");
    expect(styles).toContain(".ai-panel.is-roleplaying .ai-roleplay-character");
  });
});
