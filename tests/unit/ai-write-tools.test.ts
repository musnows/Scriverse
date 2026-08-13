import { describe, expect, it } from "vitest";
import { createTestRuntime, createWork } from "../helpers.js";
import type { Runtime } from "../../src/app.js";
import type { AiChatWriteContext } from "../../src/ai.js";

type AgentToolId = string;

type ToolCallInput = { id: string; type: "function"; function: { name: string; arguments: unknown } };

function executeTool(
  runtime: Runtime,
  workId: string,
  toolCall: ToolCallInput,
  allowedToolIds: ReadonlySet<string>,
  context: AiChatWriteContext
): Promise<Record<string, unknown>> {
  const manager = runtime.ai as unknown as {
    executeAgentTool: (
      workId: string,
      toolCall: ToolCallInput,
      maximumResultChars: number,
      roleplayCharacterId: string | null,
      allowedToolIds: ReadonlySet<string>,
      signal: undefined,
      onUsage: undefined,
      writeContext: AiChatWriteContext
    ) => Promise<Record<string, unknown>>;
  };
  return manager.executeAgentTool(workId, toolCall, 10_000, null, allowedToolIds, undefined, undefined, context);
}

function writeContext(conversationId: string, owner: string): AiChatWriteContext {
  return {
    conversationId,
    requesterUserId: owner,
    conversationOwnerUserId: owner,
    planOperations: [],
    question: null
  };
}

describe("AI 可写工具执行链路", () => {
  let runtime: Runtime;

  it("工具开关未开启时写工具不可用", async () => {
    runtime = createTestRuntime();
    try {
      const work = await createWork(runtime);
      // 默认 aiWriteTools 为空
      const enabled = (runtime.ai as unknown as {
        enabledAiWriteToolIds: (workId: string, requested: ReadonlySet<AgentToolId> | null) => AgentToolId[]
      }).enabledAiWriteToolIds(String(work.id), null);
      expect(enabled).toEqual([]);
    } finally {
      runtime.close();
    }
  });

  it("开启开关后按模块权限过滤写工具", async () => {
    runtime = createTestRuntime();
    try {
      const work = await createWork(runtime);
      runtime.store.updateWorkAiSettings(String(work.id), {
        aiWriteTools: ["entity:settings", "annotation", "analysis-task", "ask-question"]
      });
      const enabled = (runtime.ai as unknown as {
        enabledAiWriteToolIds: (workId: string, requested: ReadonlySet<AgentToolId> | null) => AgentToolId[]
      }).enabledAiWriteToolIds(String(work.id), null);
      expect(enabled).toEqual([
        "create_story_entity",
        "update_story_entity",
        "create_chapter_annotation",
        "create_analysis_task",
        "ask_user_question"
      ]);
    } finally {
      runtime.close();
    }
  });

  it("create_story_entity 收集草稿且不写库", async () => {
    runtime = createTestRuntime();
    try {
      const work = await createWork(runtime);
      runtime.store.updateWorkAiSettings(String(work.id), { aiWriteTools: ["entity:settings"] });
      const context = writeContext("conversation_1", "user_1");
      const result = await executeTool(runtime, String(work.id), { id: "call_1", type: "function", function: { name: "create_story_entity", arguments: JSON.stringify({ entityType: "setting", fields: { title: "新设定", content: "内容", hacker: "注入字段" }, summary: "新增设定" }) } }, new Set(["create_story_entity", "update_story_entity"]), context);
      expect(result.status).toBe("completed");
      expect((result.result as Record<string, unknown>).ok).toBe(true);
      expect(context.planOperations).toHaveLength(1);
      const operation = context.planOperations[0] as Record<string, unknown>;
      expect(operation.operationType).toBe("entity_create");
      expect(operation.after).toEqual({ title: "新设定", content: "内容" });
      expect((operation.diff as unknown[]).every((entry) => (entry as Record<string, unknown>).field !== "hacker")).toBe(true);
      // 未写库
      expect(runtime.store.listSettings(String(work.id))).toHaveLength(0);
    } finally {
      runtime.close();
    }
  });

  it("update_story_entity 版本不匹配时拒绝", async () => {
    runtime = createTestRuntime();
    try {
      const work = await createWork(runtime);
      runtime.store.updateWorkAiSettings(String(work.id), { aiWriteTools: ["entity:settings"] });
      const setting = runtime.store.createSetting(String(work.id), { title: "旧设定", category: "", content: "" });
      const context = writeContext("conversation_1", "user_1");
      const result = await executeTool(runtime, String(work.id), { id: "call_2", type: "function", function: { name: "update_story_entity", arguments: JSON.stringify({ entityType: "setting", entityId: String(setting.id), expectedVersionNo: 999, fields: { title: "新设定" }, summary: "修改设定" }) } }, new Set(["create_story_entity", "update_story_entity"]), context);
      expect(result.status).toBe("failed");
      const error = (result.result as Record<string, unknown>).error as Record<string, unknown>;
      expect(error.code).toBe("WRITE_TARGET_VERSION_CHANGED");
      expect(context.planOperations).toHaveLength(0);
    } finally {
      runtime.close();
    }
  });

  it("跨作品目标 ID 被拒绝", async () => {
    runtime = createTestRuntime();
    try {
      const work = await createWork(runtime);
      const otherWork = await createWork(runtime, "其他作品");
      runtime.store.updateWorkAiSettings(String(work.id), { aiWriteTools: ["entity:settings"] });
      const otherSetting = runtime.store.createSetting(String(otherWork.id), { title: "他作设定", category: "", content: "" });
      const context = writeContext("conversation_1", "user_1");
      const result = await executeTool(runtime, String(work.id), { id: "call_3", type: "function", function: { name: "update_story_entity", arguments: JSON.stringify({ entityType: "setting", entityId: String(otherSetting.id), expectedVersionNo: 1, fields: { title: "篡改" }, summary: "越权修改" }) } }, new Set(["create_story_entity", "update_story_entity"]), context);
      expect(result.status).toBe("failed");
      const error = (result.result as Record<string, unknown>).error as Record<string, unknown>;
      expect(error.code).toBe("WRITE_TARGET_WORK_MISMATCH");
    } finally {
      runtime.close();
    }
  });

  it("操作数量超过上限时拒绝并提示拆分", async () => {
    runtime = createTestRuntime();
    try {
      const work = await createWork(runtime);
      runtime.store.updateWorkAiSettings(String(work.id), { aiWriteTools: ["entity:settings"] });
      const context = writeContext("conversation_1", "user_1");
      // 预置 5 项达到默认上限
      for (let index = 0; index < 5; index += 1) {
        context.planOperations.push({
          operationType: "entity_create",
          entityType: "setting",
          targetModule: "settings",
          aiSummary: `操作 ${index}`,
          before: null,
          after: { title: `设定 ${index}`, content: "" },
          diff: []
        });
      }
      const result = await executeTool(runtime, String(work.id), { id: "call_4", type: "function", function: { name: "create_story_entity", arguments: JSON.stringify({ entityType: "setting", fields: { title: "超限设定", content: "" }, summary: "超限" }) } }, new Set(["create_story_entity", "update_story_entity"]), context);
      expect(result.status).toBe("failed");
      const error = (result.result as Record<string, unknown>).error as Record<string, unknown>;
      expect(error.code).toBe("WRITE_PLAN_OPERATION_LIMIT");
      expect(context.planOperations).toHaveLength(5);
    } finally {
      runtime.close();
    }
  });

  it("ask_user_question 一次只允许一个问题且选项不少于两个", async () => {
    runtime = createTestRuntime();
    try {
      const work = await createWork(runtime);
      runtime.store.updateWorkAiSettings(String(work.id), { aiWriteTools: ["ask-question"] });
      const context = writeContext("conversation_1", "user_1");
      const singleOption = await executeTool(runtime, String(work.id), { id: "call_5", type: "function", function: { name: "ask_user_question", arguments: JSON.stringify({ question: "只有一个选项？", options: [{ label: "唯一选项" }], summary: "测试" }) } }, new Set(["ask_user_question"]), context);
      expect(singleOption.status).toBe("failed");
      const first = await executeTool(runtime, String(work.id), { id: "call_6", type: "function", function: { name: "ask_user_question", arguments: JSON.stringify({ question: "方向？", options: [{ label: "推荐方向" }, { label: "保守方向" }], summary: "测试" }) } }, new Set(["ask_user_question"]), context);
      expect(first.status).toBe("completed");
      expect(context.question?.question).toBe("方向？");
      expect(context.question?.options).toHaveLength(2);
      const second = await executeTool(runtime, String(work.id), { id: "call_7", type: "function", function: { name: "ask_user_question", arguments: JSON.stringify({ question: "第二个问题？", options: [{ label: "选项一" }, { label: "选项二" }], summary: "测试" }) } }, new Set(["ask_user_question"]), context);
      expect(second.status).toBe("failed");
      const error = (second.result as Record<string, unknown>).error as Record<string, unknown>;
      expect(error.code).toBe("QUESTION_ALREADY_PENDING");
    } finally {
      runtime.close();
    }
  });

  it("create_chapter_annotation 校验行号与章节归属", async () => {
    runtime = createTestRuntime();
    try {
      const work = await createWork(runtime);
      runtime.store.updateWorkAiSettings(String(work.id), { aiWriteTools: ["annotation"] });
      const volume = runtime.store.createVolume(String(work.id), { title: "第一卷" });
      const chapter = runtime.store.createChapter(String(work.id), { volumeId: String(volume.id), title: "第一章", content: "第一行\n第二行" });
      const context = writeContext("conversation_1", "user_1");
      const outOfRange = await executeTool(runtime, String(work.id), { id: "call_8", type: "function", function: { name: "create_chapter_annotation", arguments: JSON.stringify({ chapterId: String(chapter.id), kind: "note", startLine: 1, endLine: 99, note: "越界批注", summary: "测试" }) } }, new Set(["create_chapter_annotation"]), context);
      expect(outOfRange.status).toBe("failed");
      expect(((outOfRange.result as Record<string, unknown>).error as Record<string, unknown>).code).toBe("ANNOTATION_LINE_RANGE_INVALID");
      const valid = await executeTool(runtime, String(work.id), { id: "call_9", type: "function", function: { name: "create_chapter_annotation", arguments: JSON.stringify({ chapterId: String(chapter.id), kind: "todo", startLine: 1, endLine: 2, note: "待办内容", summary: "测试" }) } }, new Set(["create_chapter_annotation"]), context);
      expect(valid.status).toBe("completed");
      expect(context.planOperations).toHaveLength(1);
      const operation = context.planOperations[0] as Record<string, unknown>;
      expect(operation.operationType).toBe("annotation_create");
      const after = operation.after as Record<string, unknown>;
      expect(after.quote).toBe("第一行\n第二行");
      // 批注未写库，正文未变化
      expect(runtime.store.listChapterAnnotations(String(chapter.id))).toHaveLength(0);
      expect(runtime.store.getChapter(String(chapter.id)).content).toBe("第一行\n第二行");
    } finally {
      runtime.close();
    }
  });

  it("create_analysis_task 校验任务类型与范围引用", async () => {
    runtime = createTestRuntime();
    try {
      const work = await createWork(runtime);
      runtime.store.updateWorkAiSettings(String(work.id), { aiWriteTools: ["analysis-task"] });
      const otherWork = await createWork(runtime, "其他作品");
      const otherVolume = runtime.store.createVolume(String(otherWork.id), { title: "他作卷" });
      const otherChapter = runtime.store.createChapter(String(otherWork.id), { volumeId: String(otherVolume.id), title: "他作章节", content: "" });
      const context = writeContext("conversation_1", "user_1");
      const crossWork = await executeTool(runtime, String(work.id), { id: "call_10", type: "function", function: { name: "create_analysis_task", arguments: JSON.stringify({ taskType: "chapter-analysis", scope: { type: "chapter", chapterId: String(otherChapter.id) }, summary: "跨作品分析" }) } }, new Set(["create_analysis_task"]), context);
      expect(crossWork.status).toBe("failed");
      expect(((crossWork.result as Record<string, unknown>).error as Record<string, unknown>).code).toBe("ANALYSIS_SCOPE_INVALID");
      const valid = await executeTool(runtime, String(work.id), { id: "call_11", type: "function", function: { name: "create_analysis_task", arguments: JSON.stringify({ taskType: "book-analysis", scope: { type: "book" }, summary: "全书分析" }) } }, new Set(["create_analysis_task"]), context);
      expect(valid.status).toBe("completed");
      expect(context.planOperations).toHaveLength(1);
      // 任务未直接入队
      expect(runtime.store.listTaskSummariesPage(String(work.id), { page: 1, limit: 10, offset: 0 }).items).toHaveLength(0);
    } finally {
      runtime.close();
    }
  });

  it("create_story_entity 支持新建章节大纲并保留 chapterId", async () => {
    runtime = createTestRuntime();
    try {
      const work = await createWork(runtime);
      runtime.store.updateWorkAiSettings(String(work.id), { aiWriteTools: ["entity:outlines"] });
      const volume = runtime.store.createVolume(String(work.id), { title: "第一卷" });
      const chapter = runtime.store.createChapter(String(work.id), { volumeId: String(volume.id), title: "第一章", content: "正文" });
      const context = writeContext("conversation_1", "user_1");
      const result = await executeTool(
        runtime,
        String(work.id),
        { id: "call_12", type: "function", function: { name: "create_story_entity", arguments: JSON.stringify({ entityType: "outline", fields: { chapterId: String(chapter.id), goal: "引出主角", status: "draft" }, summary: "新建章节大纲" }) } },
        new Set(["create_story_entity", "update_story_entity"]),
        context
      );
      expect(result.status).toBe("completed");
      expect(context.planOperations).toHaveLength(1);
      const operation = context.planOperations[0] as Record<string, unknown>;
      const after = operation.after as Record<string, unknown>;
      expect(after.chapterId).toBe(String(chapter.id));
      expect(after.goal).toBe("引出主角");
      const diffFields = (operation.diff as Array<Record<string, unknown>>).map((entry) => entry.field);
      expect(diffFields).toContain("chapterId");
      expect(diffFields).toContain("goal");
      // 跨作品章节被拒绝
      const otherWork = await createWork(runtime, "其他作品");
      const otherVolume = runtime.store.createVolume(String(otherWork.id), { title: "外卷" });
      const otherChapter = runtime.store.createChapter(String(otherWork.id), { volumeId: String(otherVolume.id), title: "外章", content: "" });
      const crossWork = await executeTool(
        runtime,
        String(work.id),
        { id: "call_13", type: "function", function: { name: "create_story_entity", arguments: JSON.stringify({ entityType: "outline", fields: { chapterId: String(otherChapter.id), goal: "越权" }, summary: "越权大纲" }) } },
        new Set(["create_story_entity", "update_story_entity"]),
        context
      );
      expect(crossWork.status).toBe("failed");
      expect(((crossWork.result as Record<string, unknown>).error as Record<string, unknown>).code).toBe("OUTLINE_CHAPTER_WORK_MISMATCH");
    } finally {
      runtime.close();
    }
  });
});
