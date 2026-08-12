import { createServer, type Server } from "node:http";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { createTestRuntime, createWork, seedChapter } from "../helpers.js";
import { runWithRequestActor } from "../../src/request-context.js";

function seedUser(runtime: Runtime, id: string, username: string): void {
  const timestamp = new Date().toISOString();
  runtime.database.run(
    `INSERT INTO users (id, username, normalized_username, display_name, password_hash, password_salt, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'hash', 'salt', 'user', 'active', ?, ?)`,
    id,
    username,
    username,
    username,
    timestamp,
    timestamp
  );
}

function seedWorkOwner(runtime: Runtime, workId: string, userId: string): void {
  runtime.database.run("UPDATE works SET owner_user_id = ? WHERE id = ?", userId, workId);
  runtime.database.run(
    "INSERT INTO work_memberships (work_id, user_id, role, invited_by_user_id, created_at) VALUES (?, ?, 'owner', ?, ?)",
    workId,
    userId,
    userId,
    new Date().toISOString()
  );
}

function enableWriteTools(runtime: Runtime, workId: string, tools: Record<string, boolean>): void {
  runtime.store.updateWorkAiSettings(workId, { writeTools: tools });
}

type PlanOperationInput = {
  opType: string;
  module: string;
  entityType: string;
  targetId?: string | null;
  targetVersion?: number | null;
  targetLabel: string;
  aiSummary: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  diff: Array<Record<string, unknown>>;
};

async function expectPlanError(actor: Record<string, unknown>, attempt: () => unknown, code: string): Promise<void> {
  try {
    await runWithRequestActor(actor as never, () => attempt());
    expect.unreachable(`应当抛出 ${code}`);
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
  }
}

const testActor = {
  userId: "user-owner",
  username: "owner_user",
  displayName: "owner_user",
  role: "user",
  status: "active",
  createdAt: "",
  avatarUrl: null,
  onboardingCompleted: true
};

function createPendingPlan(runtime: Runtime, workId: string, conversationId: string, creatorUserId: string, ownerUserId: string, operations: PlanOperationInput[]): Record<string, unknown> {
  const plan = runtime.store.createDraftAiWritePlan(workId, conversationId, creatorUserId, ownerUserId);
  for (const operation of operations) {
    runtime.store.addAiWritePlanOperation(String(plan.id), operation as never);
  }
  const submitted = runtime.store.submitDraftAiWritePlan(conversationId);
  if (!submitted) throw new Error("计划提交失败");
  return submitted;
}

describe("AI 修改计划与执行引擎", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = createTestRuntime();
    seedUser(runtime, "user-owner", "owner_user");
    seedUser(runtime, "user-member", "member_user");
  });
  afterEach(() => runtime.close());

  it("操作数超出上限时拒绝添加", async () => {
    const work = await createWork(runtime);
    seedWorkOwner(runtime, String(work.id), "user-owner");
    const conversation = runtime.store.createAiConversation(String(work.id));
    runtime.database.run("UPDATE ai_conversations SET created_by_user_id = 'user-owner' WHERE id = ?", String(conversation.id));
    const plan = runtime.store.createDraftAiWritePlan(String(work.id), String(conversation.id), "user-owner", "user-owner");
    const operation: PlanOperationInput = {
      opType: "create-entry",
      module: "settings",
      entityType: "setting",
      targetLabel: "世界设定「新设定」",
      aiSummary: "新建一条设定",
      before: null,
      after: { title: "新设定", category: "地理", content: "内容" },
      diff: []
    };
    for (let index = 0; index < 5; index += 1) {
      runtime.store.addAiWritePlanOperation(String(plan.id), operation as never);
    }
    expect(() => runtime.store.addAiWritePlanOperation(String(plan.id), operation as never)).toThrowError(/最多包含 5 项操作/u);
  });

  it("执行成功：新建词条、编辑词条、创建批注与创建分析任务", async () => {
    const { work, volume, chapter } = await seedChapter(runtime, "第一行。\n第二行。\n第三行。");
    seedWorkOwner(runtime, String(work.id), "user-owner");
    const conversation = runtime.store.createAiConversation(String(work.id));
    runtime.database.run("UPDATE ai_conversations SET created_by_user_id = 'user-owner' WHERE id = ?", String(conversation.id));
    enableWriteTools(runtime, String(work.id), { settings: true, characters: true, "prose-annotations": true, "analysis-tasks": true });
    const setting = runtime.store.createSetting(String(work.id), { title: "旧设定", category: "地理", content: "旧内容" });
    const plan = createPendingPlan(runtime, String(work.id), String(conversation.id), "user-owner", "user-owner", [
      {
        opType: "create-entry",
        module: "characters",
        entityType: "character",
        targetLabel: "角色「林舟」",
        aiSummary: "新建角色林舟",
        before: null,
        after: { name: "林舟" },
        diff: [{ field: "name", label: "名称", before: null, after: "林舟" }]
      },
      {
        opType: "update-entry",
        module: "settings",
        entityType: "setting",
        targetId: String(setting.id),
        targetVersion: Number(setting.versionNo),
        targetLabel: "世界设定「旧设定」",
        aiSummary: "修改设定标题",
        before: { title: "旧设定", category: "地理", content: "旧内容" },
        after: { title: "新设定" },
        diff: [{ field: "title", label: "标题", before: "旧设定", after: "新设定" }]
      },
      {
        opType: "create-annotation",
        module: "prose",
        entityType: "chapter-annotation",
        targetId: String(chapter.id),
        targetVersion: Number(chapter.versionNo),
        targetLabel: `章节「${String(chapter.title)}」`,
        aiSummary: "为第二行添加待办",
        before: { chapterId: String(chapter.id), startLine: 2, endLine: 2, quote: "第二行。" },
        after: { chapterId: String(chapter.id), kind: "todo", startLine: 2, endLine: 2, note: "这里需要补充描写" },
        diff: []
      },
      {
        opType: "create-task",
        module: "ai-analysis",
        entityType: "analysis-task",
        targetLabel: "分析任务「chapter-analysis」",
        aiSummary: "分析第一章",
        before: null,
        after: { taskType: "chapter-analysis", scope: { type: "chapter", chapterId: String(chapter.id) }, modelId: null },
        diff: []
      }
    ]);
    const executed = await runWithRequestActor(testActor as never, () => runtime.ai.executeAiWritePlan(String(plan.id), "user-owner"));
    expect(executed.status).toBe("executed");
    const executedOperations = executed.operations as Record<string, unknown>[];
    expect(executedOperations.map((operation) => operation.status)).toEqual(["executed", "executed", "executed", "executed"]);
    const characters = runtime.store.listCharacters(String(work.id));
    expect(characters).toHaveLength(1);
    expect(String(characters[0]?.name ?? "")).toBe("林舟");
    const updatedSetting = runtime.store.getSetting(String(setting.id));
    expect(String(updatedSetting.title)).toBe("新设定");
    const annotations = runtime.store.listWorkChapterAnnotations(String(work.id));
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.kind).toBe("todo");
    expect(String(annotations[0]?.quote ?? "")).toBe("第二行。");
    const tasks = runtime.store.listTaskSummariesPage(String(work.id), { page: 1, limit: 10, offset: 0 });
    expect(tasks.items).toHaveLength(1);
    expect(tasks.items[0]?.taskType).toBe("chapter-analysis");
    // 审计与版本记录
    const auditRows = runtime.database.all("SELECT * FROM audit_logs WHERE action = 'ai-plan.executed' AND entity_id = ?", String(plan.id));
    expect(auditRows).toHaveLength(1);
    const settingVersions = runtime.store.listEntityVersions("setting", String(setting.id));
    expect(settingVersions.some((version) => version.source === "ai-write-plan")).toBe(true);
  });

  it("任一操作失败时整份计划原子回滚", async () => {
    const work = await createWork(runtime);
    seedWorkOwner(runtime, String(work.id), "user-owner");
    const conversation = runtime.store.createAiConversation(String(work.id));
    runtime.database.run("UPDATE ai_conversations SET created_by_user_id = 'user-owner' WHERE id = ?", String(conversation.id));
    enableWriteTools(runtime, String(work.id), { settings: true, races: true });
    runtime.store.createRace(String(work.id), { name: "精灵" });
    const plan = createPendingPlan(runtime, String(work.id), String(conversation.id), "user-owner", "user-owner", [
      {
        opType: "create-entry",
        module: "settings",
        entityType: "setting",
        targetLabel: "世界设定「新设定」",
        aiSummary: "新建设定",
        before: null,
        after: { title: "新设定", category: "地理", content: "内容" },
        diff: []
      },
      {
        opType: "create-entry",
        module: "races",
        entityType: "race",
        targetLabel: "种族「精灵」",
        aiSummary: "新建重名种族",
        before: null,
        after: { name: "精灵" },
        diff: []
      }
    ]);
    await expectPlanError(testActor, () => runtime.ai.executeAiWritePlan(String(plan.id), "user-owner"), "RACE_NAME_CONFLICT");
    const after = runtime.store.getAiWritePlan(String(plan.id));
    expect(after.status).toBe("failed");
    expect(runtime.store.listSettings(String(work.id))).toHaveLength(0);
    expect(runtime.store.listRaces(String(work.id))).toHaveLength(1);
  });

  it("每份审批只能成功执行一次", async () => {
    const work = await createWork(runtime);
    seedWorkOwner(runtime, String(work.id), "user-owner");
    const conversation = runtime.store.createAiConversation(String(work.id));
    runtime.database.run("UPDATE ai_conversations SET created_by_user_id = 'user-owner' WHERE id = ?", String(conversation.id));
    enableWriteTools(runtime, String(work.id), { settings: true });
    const plan = createPendingPlan(runtime, String(work.id), String(conversation.id), "user-owner", "user-owner", [
      {
        opType: "create-entry",
        module: "settings",
        entityType: "setting",
        targetLabel: "世界设定「新设定」",
        aiSummary: "新建设定",
        before: null,
        after: { title: "新设定", category: "地理", content: "内容" },
        diff: []
      }
    ]);
    await runWithRequestActor(testActor as never, () => runtime.ai.executeAiWritePlan(String(plan.id), "user-owner"));
    await expectPlanError(testActor, () => runtime.ai.executeAiWritePlan(String(plan.id), "user-owner"), "PLAN_NOT_PENDING");
    expect(runtime.store.listSettings(String(work.id))).toHaveLength(1);
  });

  it("执行前目标版本变化时审批失效且不写入", async () => {
    const work = await createWork(runtime);
    seedWorkOwner(runtime, String(work.id), "user-owner");
    const conversation = runtime.store.createAiConversation(String(work.id));
    runtime.database.run("UPDATE ai_conversations SET created_by_user_id = 'user-owner' WHERE id = ?", String(conversation.id));
    enableWriteTools(runtime, String(work.id), { settings: true });
    const setting = runtime.store.createSetting(String(work.id), { title: "旧设定", category: "地理", content: "旧内容" });
    const plan = createPendingPlan(runtime, String(work.id), String(conversation.id), "user-owner", "user-owner", [
      {
        opType: "update-entry",
        module: "settings",
        entityType: "setting",
        targetId: String(setting.id),
        targetVersion: Number(setting.versionNo),
        targetLabel: "世界设定「旧设定」",
        aiSummary: "修改标题",
        before: { title: "旧设定" },
        after: { title: "新设定" },
        diff: []
      }
    ]);
    // 计划创建后词条被他人修改
    runtime.store.updateSetting(String(setting.id), { title: "已被他人修改" });
    await expectPlanError(testActor, () => runtime.ai.executeAiWritePlan(String(plan.id), "user-owner"), "PLAN_INVALID");
    const after = runtime.store.getAiWritePlan(String(plan.id));
    expect(after.status).toBe("invalid");
    expect(String(after.invalidReason)).toContain("版本已发生变化");
    expect(String(runtime.store.getSetting(String(setting.id)).title)).toBe("已被他人修改");
  });

  it("执行前工具开关关闭时审批失效", async () => {
    const work = await createWork(runtime);
    seedWorkOwner(runtime, String(work.id), "user-owner");
    const conversation = runtime.store.createAiConversation(String(work.id));
    runtime.database.run("UPDATE ai_conversations SET created_by_user_id = 'user-owner' WHERE id = ?", String(conversation.id));
    const plan = createPendingPlan(runtime, String(work.id), String(conversation.id), "user-owner", "user-owner", [
      {
        opType: "create-entry",
        module: "characters",
        entityType: "character",
        targetLabel: "角色「林舟」",
        aiSummary: "新建角色",
        before: null,
        after: { name: "林舟" },
        diff: []
      }
    ]);
    // 未开启 characters 开关（默认全部关闭）
    await expectPlanError(testActor, () => runtime.ai.executeAiWritePlan(String(plan.id), "user-owner"), "PLAN_INVALID");
    const after = runtime.store.getAiWritePlan(String(plan.id));
    expect(after.status).toBe("invalid");
    expect(String(after.invalidReason)).toContain("已关闭");
    expect(runtime.store.listCharacters(String(work.id))).toHaveLength(0);
  });

  it("当前用户与对话归属用户权限交集不足时审批失效", async () => {
    const work = await createWork(runtime);
    seedWorkOwner(runtime, String(work.id), "user-owner");
    const timestamp = new Date().toISOString();
    runtime.database.run(
      `INSERT INTO work_memberships (work_id, user_id, role, invited_by_user_id, permissions_json, created_at)
       VALUES (?, 'user-member', 'editor', 'user-owner', ?, ?)`,
      String(work.id),
      JSON.stringify({ modules: { characters: "read", settings: "read" } }),
      timestamp
    );
    const conversation = runtime.store.createAiConversation(String(work.id));
    runtime.database.run("UPDATE ai_conversations SET created_by_user_id = 'user-member' WHERE id = ?", String(conversation.id));
    enableWriteTools(runtime, String(work.id), { characters: true });
    const plan = createPendingPlan(runtime, String(work.id), String(conversation.id), "user-owner", "user-member", [
      {
        opType: "create-entry",
        module: "characters",
        entityType: "character",
        targetLabel: "角色「林舟」",
        aiSummary: "新建角色",
        before: null,
        after: { name: "林舟" },
        diff: []
      }
    ]);
    // owner 有写权限但对话归属用户 member 只有读权限，交集无写权限
    await expectPlanError(testActor, () => runtime.ai.executeAiWritePlan(String(plan.id), "user-owner"), "PLAN_INVALID");
    const after = runtime.store.getAiWritePlan(String(plan.id));
    expect(after.status).toBe("invalid");
    expect(String(after.invalidReason)).toContain("写权限");
  });

  it("对话归属用户失去作品权限时审批失效", async () => {
    const work = await createWork(runtime);
    seedWorkOwner(runtime, String(work.id), "user-owner");
    const conversation = runtime.store.createAiConversation(String(work.id));
    runtime.database.run("UPDATE ai_conversations SET created_by_user_id = 'user-member' WHERE id = ?", String(conversation.id));
    enableWriteTools(runtime, String(work.id), { settings: true });
    const plan = createPendingPlan(runtime, String(work.id), String(conversation.id), "user-owner", "user-member", [
      {
        opType: "create-entry",
        module: "settings",
        entityType: "setting",
        targetLabel: "世界设定「新设定」",
        aiSummary: "新建设定",
        before: null,
        after: { title: "新设定", category: "地理", content: "内容" },
        diff: []
      }
    ]);
    await expectPlanError(testActor, () => runtime.ai.executeAiWritePlan(String(plan.id), "user-owner"), "PLAN_INVALID");
    expect(runtime.store.getAiWritePlan(String(plan.id)).status).toBe("invalid");
  });

  it("过期审批无法执行并标记为已过期", async () => {
    const work = await createWork(runtime);
    seedWorkOwner(runtime, String(work.id), "user-owner");
    const conversation = runtime.store.createAiConversation(String(work.id));
    runtime.database.run("UPDATE ai_conversations SET created_by_user_id = 'user-owner' WHERE id = ?", String(conversation.id));
    enableWriteTools(runtime, String(work.id), { settings: true });
    const plan = createPendingPlan(runtime, String(work.id), String(conversation.id), "user-owner", "user-owner", [
      {
        opType: "create-entry",
        module: "settings",
        entityType: "setting",
        targetLabel: "世界设定「新设定」",
        aiSummary: "新建设定",
        before: null,
        after: { title: "新设定", category: "地理", content: "内容" },
        diff: []
      }
    ]);
    runtime.database.run(
      "UPDATE ai_write_plans SET created_at = ? WHERE id = ?",
      new Date(Date.now() - 48 * 3_600_000).toISOString(),
      String(plan.id)
    );
    await expectPlanError(testActor, () => runtime.ai.executeAiWritePlan(String(plan.id), "user-owner"), "PLAN_EXPIRED");
    expect(runtime.store.getAiWritePlan(String(plan.id)).status).toBe("expired");
    expect(runtime.store.listSettings(String(work.id))).toHaveLength(0);
  });

  it("拒绝后无法执行", async () => {
    const work = await createWork(runtime);
    seedWorkOwner(runtime, String(work.id), "user-owner");
    const conversation = runtime.store.createAiConversation(String(work.id));
    runtime.database.run("UPDATE ai_conversations SET created_by_user_id = 'user-owner' WHERE id = ?", String(conversation.id));
    enableWriteTools(runtime, String(work.id), { settings: true });
    const plan = createPendingPlan(runtime, String(work.id), String(conversation.id), "user-owner", "user-owner", [
      {
        opType: "create-entry",
        module: "settings",
        entityType: "setting",
        targetLabel: "世界设定「新设定」",
        aiSummary: "新建设定",
        before: null,
        after: { title: "新设定", category: "地理", content: "内容" },
        diff: []
      }
    ]);
    const rejected = runtime.store.rejectAiWritePlan(String(plan.id), "user-owner");
    expect(rejected.status).toBe("rejected");
    await expectPlanError(testActor, () => runtime.ai.executeAiWritePlan(String(plan.id), "user-owner"), "PLAN_NOT_PENDING");
  });

  it("撤销编辑操作并拒绝被后续修改的词条", async () => {
    const work = await createWork(runtime);
    seedWorkOwner(runtime, String(work.id), "user-owner");
    const conversation = runtime.store.createAiConversation(String(work.id));
    runtime.database.run("UPDATE ai_conversations SET created_by_user_id = 'user-owner' WHERE id = ?", String(conversation.id));
    enableWriteTools(runtime, String(work.id), { settings: true, outlines: true });
    const setting = runtime.store.createSetting(String(work.id), { title: "旧设定", category: "地理", content: "旧内容" });
    const foreshadow = runtime.store.createForeshadow(String(work.id), { title: "旧伏笔", description: "旧说明" });
    const plan = createPendingPlan(runtime, String(work.id), String(conversation.id), "user-owner", "user-owner", [
      {
        opType: "update-entry",
        module: "settings",
        entityType: "setting",
        targetId: String(setting.id),
        targetVersion: Number(setting.versionNo),
        targetLabel: "世界设定「旧设定」",
        aiSummary: "修改设定标题",
        before: { title: "旧设定" },
        after: { title: "新设定" },
        diff: [{ field: "title", label: "标题", before: "旧设定", after: "新设定" }]
      },
      {
        opType: "update-entry",
        module: "outlines",
        entityType: "foreshadow",
        targetId: String(foreshadow.id),
        targetVersion: Number(foreshadow.versionNo),
        targetLabel: "伏笔「旧伏笔」",
        aiSummary: "修改伏笔标题",
        before: { title: "旧伏笔" },
        after: { title: "新伏笔" },
        diff: [{ field: "title", label: "标题", before: "旧伏笔", after: "新伏笔" }]
      }
    ]);
    await runWithRequestActor(testActor as never, () => runtime.ai.executeAiWritePlan(String(plan.id), "user-owner"));
    expect(String(runtime.store.getSetting(String(setting.id)).title)).toBe("新设定");
    expect(String(runtime.store.getForeshadow(String(foreshadow.id)).title)).toBe("新伏笔");
    // 伏笔被后续修改后撤销应失败且整体不撤销
    runtime.store.updateForeshadow(String(foreshadow.id), { title: "后续修改" });
    await expectPlanError(testActor, () => runtime.ai.undoAiWritePlan(String(plan.id), "user-owner"), "PLAN_UNDO_VERSION_CONFLICT");
    expect(String(runtime.store.getSetting(String(setting.id)).title)).toBe("新设定");
    expect(runtime.store.getAiWritePlan(String(plan.id)).undoneAt).toBeNull();
  });

  it("权限被回收后无法撤销审批", async () => {
    const work = await createWork(runtime);
    seedWorkOwner(runtime, String(work.id), "user-owner");
    const conversation = runtime.store.createAiConversation(String(work.id));
    runtime.database.run("UPDATE ai_conversations SET created_by_user_id = 'user-owner' WHERE id = ?", String(conversation.id));
    enableWriteTools(runtime, String(work.id), { settings: true });
    const setting = runtime.store.createSetting(String(work.id), { title: "旧设定", category: "地理", content: "旧内容" });
    const plan = createPendingPlan(runtime, String(work.id), String(conversation.id), "user-owner", "user-owner", [
      {
        opType: "update-entry",
        module: "settings",
        entityType: "setting",
        targetId: String(setting.id),
        targetVersion: Number(setting.versionNo),
        targetLabel: "世界设定「旧设定」",
        aiSummary: "修改设定标题",
        before: { title: "旧设定" },
        after: { title: "新设定" },
        diff: [{ field: "title", label: "标题", before: "旧设定", after: "新设定" }]
      }
    ]);
    await runWithRequestActor(testActor as never, () => runtime.ai.executeAiWritePlan(String(plan.id), "user-owner"));
    // 回收权限:计划记录的对话归属用户失去作品权限
    runtime.database.run("UPDATE ai_write_plans SET conversation_owner_user_id = 'user-member' WHERE id = ?", String(plan.id));
    await expectPlanError(testActor, () => runtime.ai.undoAiWritePlan(String(plan.id), "user-owner"), "PLAN_UNDO_DENIED");
    expect(String(runtime.store.getSetting(String(setting.id)).title)).toBe("新设定");
  });

  it("目标未被后续修改时撤销成功且不可重复撤销", async () => {
    const work = await createWork(runtime);
    seedWorkOwner(runtime, String(work.id), "user-owner");
    const conversation = runtime.store.createAiConversation(String(work.id));
    runtime.database.run("UPDATE ai_conversations SET created_by_user_id = 'user-owner' WHERE id = ?", String(conversation.id));
    enableWriteTools(runtime, String(work.id), { settings: true, outlines: true });
    const setting = runtime.store.createSetting(String(work.id), { title: "旧设定", category: "地理", content: "旧内容" });
    const plan = createPendingPlan(runtime, String(work.id), String(conversation.id), "user-owner", "user-owner", [
      {
        opType: "update-entry",
        module: "settings",
        entityType: "setting",
        targetId: String(setting.id),
        targetVersion: Number(setting.versionNo),
        targetLabel: "世界设定「旧设定」",
        aiSummary: "修改设定标题",
        before: { title: "旧设定" },
        after: { title: "新设定" },
        diff: [{ field: "title", label: "标题", before: "旧设定", after: "新设定" }]
      }
    ]);
    await runWithRequestActor(testActor as never, () => runtime.ai.executeAiWritePlan(String(plan.id), "user-owner"));
    expect(String(runtime.store.getSetting(String(setting.id)).title)).toBe("新设定");
    const undone = await runWithRequestActor(testActor as never, () => runtime.ai.undoAiWritePlan(String(plan.id), "user-owner"));
    expect(undone.undoneAt).toBeTruthy();
    expect(String(runtime.store.getSetting(String(setting.id)).title)).toBe("旧设定");
    const undoneOperations = undone.operations as Record<string, unknown>[];
    expect(undoneOperations[0]?.status).toBe("undone");
    await expectPlanError(testActor, () => runtime.ai.undoAiWritePlan(String(plan.id), "user-owner"), "PLAN_ALREADY_UNDONE");
  });

  it("仅包含新建操作的审批不支持撤销", async () => {
    const work = await createWork(runtime);
    seedWorkOwner(runtime, String(work.id), "user-owner");
    const conversation = runtime.store.createAiConversation(String(work.id));
    runtime.database.run("UPDATE ai_conversations SET created_by_user_id = 'user-owner' WHERE id = ?", String(conversation.id));
    enableWriteTools(runtime, String(work.id), { settings: true });
    const plan = createPendingPlan(runtime, String(work.id), String(conversation.id), "user-owner", "user-owner", [
      {
        opType: "create-entry",
        module: "settings",
        entityType: "setting",
        targetLabel: "世界设定「新设定」",
        aiSummary: "新建设定",
        before: null,
        after: { title: "新设定", category: "地理", content: "内容" },
        diff: []
      }
    ]);
    await runWithRequestActor(testActor as never, () => runtime.ai.executeAiWritePlan(String(plan.id), "user-owner"));
    await expectPlanError(testActor, () => runtime.ai.undoAiWritePlan(String(plan.id), "user-owner"), "PLAN_UNDO_NOT_APPLICABLE");
  });

  it("提问回答后写入隐藏消息，拒绝与过期注入对应通知", async () => {
    const work = await createWork(runtime);
    seedWorkOwner(runtime, String(work.id), "user-owner");
    const conversation = runtime.store.createAiConversation(String(work.id));
    const question = runtime.store.createAiToolQuestion(String(work.id), String(conversation.id), "选择哪个方向？", ["东方", "西方"]);
    expect(question.options).toEqual(["东方", "西方"]);
    // 已存在待回答问题时不允许再提问
    expect(() => runtime.store.createAiToolQuestion(String(work.id), String(conversation.id), "另一个问题", ["甲", "乙"]))
      .toThrowError(/已有待回答的问题/u);
    const answered = runtime.store.answerAiToolQuestion(String(question.id), "东方");
    expect(answered.status).toBe("answered");
    expect(answered.answer).toBe("东方");
    const messages = runtime.database.all(
      "SELECT * FROM ai_conversation_messages WHERE conversation_id = ? ORDER BY rowid",
      String(conversation.id)
    );
    expect(messages).toHaveLength(1);
    expect(String(messages[0]?.content ?? "")).toContain("东方");
    expect(JSON.parse(String(messages[0]?.metadata_json ?? "{}"))).toMatchObject({ source: "tool-result", hidden: true });
    // 重复回答幂等
    expect(runtime.store.answerAiToolQuestion(String(question.id), "西方").answer).toBe("东方");
    // 拒绝与过期
    const rejectedQuestion = runtime.store.createAiToolQuestion(String(work.id), String(conversation.id), "再问一个", ["甲", "乙"]);
    expect(runtime.store.rejectAiToolQuestion(String(rejectedQuestion.id)).status).toBe("rejected");
    const expiredQuestion = runtime.store.createAiToolQuestion(String(work.id), String(conversation.id), "第三个问题", ["甲", "乙"]);
    runtime.database.run(
      "UPDATE ai_tool_questions SET expires_at = ? WHERE id = ?",
      new Date(Date.now() - 1_000).toISOString(),
      String(expiredQuestion.id)
    );
    expect(() => runtime.store.answerAiToolQuestion(String(expiredQuestion.id), "甲")).toThrowError(/已过期/u);
    expect(runtime.store.getAiToolQuestion(String(expiredQuestion.id)).status).toBe("expired");
  });

  it("权限交集按模块取较小值", async () => {
    const full = runtime.store.userWorkModulePermissions("user-owner", "no-such-work");
    expect(full).toBeNull();
    const work = await createWork(runtime);
    seedWorkOwner(runtime, String(work.id), "user-owner");
    const ownerPermissions = runtime.store.userWorkModulePermissions("user-owner", String(work.id));
    expect(ownerPermissions?.characters).toBe("write");
    const outsiderPermissions = runtime.store.userWorkModulePermissions("user-member", String(work.id));
    expect(outsiderPermissions).toBeNull();
    if (ownerPermissions) {
      const readOnly = { ...ownerPermissions, characters: "read" as const };
      const merged = runtime.store.intersectWorkPermissions(ownerPermissions, readOnly);
      expect(merged.characters).toBe("read");
      expect(merged.settings).toBe("write");
    }
  });

  it("草稿计划无操作时提交即丢弃", async () => {
    const work = await createWork(runtime);
    seedWorkOwner(runtime, String(work.id), "user-owner");
    const conversation = runtime.store.createAiConversation(String(work.id));
    runtime.store.createDraftAiWritePlan(String(work.id), String(conversation.id), "user-owner", "user-owner");
    expect(runtime.store.submitDraftAiWritePlan(String(conversation.id))).toBeNull();
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM ai_write_plans")?.count).toBe(0);
  });

  it("草稿计划在生成中断后不会混入下一轮计划", async () => {
    const work = await createWork(runtime);
    seedWorkOwner(runtime, String(work.id), "user-owner");
    const conversation = runtime.store.createAiConversation(String(work.id));
    runtime.database.run("UPDATE ai_conversations SET created_by_user_id = 'user-owner' WHERE id = ?", String(conversation.id));
    enableWriteTools(runtime, String(work.id), { settings: true });
    // 第一轮:加入一条操作后模拟生成中断,丢弃草稿
    const plan = runtime.store.createDraftAiWritePlan(String(work.id), String(conversation.id), "user-owner", "user-owner");
    runtime.store.addAiWritePlanOperation(String(plan.id), {
      opType: "create-entry",
      module: "settings",
      entityType: "setting",
      targetLabel: "世界设定「失败轮设定」",
      aiSummary: "失败轮操作",
      before: null,
      after: { title: "失败轮设定", category: "地理", content: "内容" },
      diff: []
    } as never);
    runtime.store.discardDraftAiWritePlan(String(conversation.id));
    // 第二轮:新草稿只包含本轮操作
    const nextPlan = runtime.store.createDraftAiWritePlan(String(work.id), String(conversation.id), "user-owner", "user-owner");
    runtime.store.addAiWritePlanOperation(String(nextPlan.id), {
      opType: "create-entry",
      module: "settings",
      entityType: "setting",
      targetLabel: "世界设定「本轮设定」",
      aiSummary: "本轮操作",
      before: null,
      after: { title: "本轮设定", category: "地理", content: "内容" },
      diff: []
    } as never);
    const submitted = runtime.store.submitDraftAiWritePlan(String(conversation.id));
    const operations = submitted?.operations as Record<string, unknown>[];
    expect(operations).toHaveLength(1);
    expect(String(operations[0]?.targetLabel)).toBe("世界设定「本轮设定」");
  });

  it("可写工具启用受开关与权限交集约束", async () => {
    const work = await createWork(runtime);
    seedWorkOwner(runtime, String(work.id), "user-owner");
    const conversation = runtime.store.createAiConversation(String(work.id));
    runtime.database.run("UPDATE ai_conversations SET created_by_user_id = 'user-owner' WHERE id = ?", String(conversation.id));
    const enabledIds = async (): Promise<string[]> => runWithRequestActor(
      { userId: "user-owner", username: "owner_user", displayName: "owner_user", role: "user" },
      () => (runtime.ai as unknown as { enabledWriteAgentToolIds(workId: string, conversationId: string): string[] }).enabledWriteAgentToolIds(String(work.id), String(conversation.id))
    );
    // 默认全部关闭
    expect(await enabledIds()).toEqual([]);
    enableWriteTools(runtime, String(work.id), { characters: true, "ask-user-questions": true, "prose-annotations": true });
    expect(await enabledIds()).toEqual(["write_character", "create_chapter_annotation", "ask_user_question"]);
    // 对话归属用户无权限后交集为空
    runtime.database.run("UPDATE ai_conversations SET created_by_user_id = 'user-member' WHERE id = ?", String(conversation.id));
    expect(await enabledIds()).toEqual([]);
  });
});

const setupToken = "ai-write-plan-test-setup-token-with-at-least-32-characters";
type SessionCredentials = {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  user: { userId: string };
};

describe("AI 修改计划 API 与安全边界", () => {
  let runtime: Runtime;
  let authServer: Server;
  let activeApp: Runtime["app"] | null = null;

  beforeAll(async () => {
    authServer = createServer((incoming, outgoing) => {
      if (!activeApp) {
        outgoing.writeHead(503).end();
        return;
      }
      activeApp(incoming, outgoing);
    });
    await new Promise<void>((resolve, reject) => {
      const rejectStart = (error: Error) => reject(error);
      authServer.once("error", rejectStart);
      authServer.listen(0, "127.0.0.1", () => {
        authServer.off("error", rejectStart);
        authServer.unref();
        resolve();
      });
    });
  });
  afterAll(async () => {
    authServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      authServer.close((error) => error ? reject(error) : resolve());
    });
  });

  beforeEach(() => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "ai-write-plan-master-secret-with-enough-length",
      serveUi: false,
      revealCaptchaAnswer: true,
      security: { allowRegistration: true, enforceSameOrigin: true, setupToken }
    });
    activeApp = runtime.app;
  });
  afterEach(() => {
    if (activeApp === runtime.app) activeApp = null;
    runtime.close();
  });

  async function solveCaptcha(): Promise<{ captchaId: string; captchaAnswer: string }> {
    const response = await request(authServer).get("/api/auth/captcha").expect(200);
    return { captchaId: response.body.data.captchaId, captchaAnswer: response.body.data.answer };
  }

  async function register(username: string): Promise<SessionCredentials> {
    const agent = request.agent(authServer);
    const captcha = await solveCaptcha();
    const response = await agent.post("/api/auth/register").send({
      username,
      password: "secure-password-123",
      passwordConfirmation: "secure-password-123",
      setupToken,
      ...captcha
    }).expect(201);
    return { agent, csrfToken: response.body.data.csrfToken, user: response.body.data.user };
  }

  async function createAuthWork(owner: SessionCredentials): Promise<{ workId: string }> {
    const response = await owner.agent.post("/api/works").set("X-CSRF-Token", owner.csrfToken).send({ title: "审批测试作品" }).expect(201);
    return { workId: String(response.body.data.id) };
  }

  async function createAuthConversation(owner: SessionCredentials, workId: string): Promise<{ conversationId: string }> {
    const response = await owner.agent.post(`/api/works/${workId}/ai-conversations`).set("X-CSRF-Token", owner.csrfToken).send({}).expect(201);
    return { conversationId: String(response.body.data.id) };
  }

  it("未登录访问审批列表返回 401", async () => {
    const owner = await register("plan_owner");
    const { workId } = await createAuthWork(owner);
    await request(authServer).get(`/api/works/${workId}/ai-write-plans`).expect(401);
  });

  it("缺少 CSRF 的确认请求被拒绝", async () => {
    const owner = await register("plan_owner");
    const { workId } = await createAuthWork(owner);
    const { conversationId } = await createAuthConversation(owner, workId);
    const plan = runtime.store.createDraftAiWritePlan(workId, conversationId, owner.user.userId, owner.user.userId);
    runtime.store.addAiWritePlanOperation(String(plan.id), {
      opType: "create-entry",
      module: "settings",
      entityType: "setting",
      targetLabel: "世界设定「新设定」",
      aiSummary: "新建设定",
      before: null,
      after: { title: "新设定", category: "地理", content: "内容" },
      diff: []
    } as never);
    runtime.store.submitDraftAiWritePlan(conversationId);
    await owner.agent.post(`/api/works/${workId}/ai-write-plans/${String(plan.id)}/approve`).send({}).expect(403);
    expect(runtime.store.getAiWritePlan(String(plan.id)).status).toBe("pending");
  });

  it("跨作品传入审批 ID 被拒绝", async () => {
    const owner = await register("plan_owner");
    const { workId } = await createAuthWork(owner);
    const otherWork = await owner.agent.post("/api/works").set("X-CSRF-Token", owner.csrfToken).send({ title: "另一个作品" }).expect(201);
    const otherWorkId = String(otherWork.body.data.id);
    const { conversationId } = await createAuthConversation(owner, workId);
    const plan = runtime.store.createDraftAiWritePlan(workId, conversationId, owner.user.userId, owner.user.userId);
    runtime.store.addAiWritePlanOperation(String(plan.id), {
      opType: "create-entry",
      module: "settings",
      entityType: "setting",
      targetLabel: "世界设定「新设定」",
      aiSummary: "新建设定",
      before: null,
      after: { title: "新设定", category: "地理", content: "内容" },
      diff: []
    } as never);
    runtime.store.submitDraftAiWritePlan(conversationId);
    await owner.agent.post(`/api/works/${otherWorkId}/ai-write-plans/${String(plan.id)}/approve`)
      .set("X-CSRF-Token", owner.csrfToken).send({}).expect(400);
    expect(runtime.store.getAiWritePlan(String(plan.id)).status).toBe("pending");
  });

  it("非发起用户无法查看、确认或撤销审批", async () => {
    const owner = await register("plan_owner");
    const outsider = await register("plan_outsider");
    const { workId } = await createAuthWork(owner);
    const { conversationId } = await createAuthConversation(owner, workId);
    const plan = runtime.store.createDraftAiWritePlan(workId, conversationId, owner.user.userId, owner.user.userId);
    runtime.store.addAiWritePlanOperation(String(plan.id), {
      opType: "create-entry",
      module: "settings",
      entityType: "setting",
      targetLabel: "世界设定「新设定」",
      aiSummary: "新建设定",
      before: null,
      after: { title: "新设定", category: "地理", content: "内容" },
      diff: []
    } as never);
    runtime.store.submitDraftAiWritePlan(conversationId);
    await outsider.agent.get(`/api/works/${workId}/ai-write-plans/${String(plan.id)}`).expect(403);
    await outsider.agent.post(`/api/works/${workId}/ai-write-plans/${String(plan.id)}/approve`)
      .set("X-CSRF-Token", outsider.csrfToken).send({}).expect(403);
    await outsider.agent.post(`/api/works/${workId}/ai-write-plans/${String(plan.id)}/reject`)
      .set("X-CSRF-Token", outsider.csrfToken).send({}).expect(403);
    expect(runtime.store.getAiWritePlan(String(plan.id)).status).toBe("pending");
  });

  it("确认接口忽略前端重提交的内容，只按审批 ID 执行系统生成的计划", async () => {
    const owner = await register("plan_owner");
    const { workId } = await createAuthWork(owner);
    const { conversationId } = await createAuthConversation(owner, workId);
    runtime.store.updateWorkAiSettings(workId, { writeTools: { settings: true } });
    const plan = runtime.store.createDraftAiWritePlan(workId, conversationId, owner.user.userId, owner.user.userId);
    runtime.store.addAiWritePlanOperation(String(plan.id), {
      opType: "create-entry",
      module: "settings",
      entityType: "setting",
      targetLabel: "世界设定「系统计划」",
      aiSummary: "新建设定",
      before: null,
      after: { title: "系统计划", category: "地理", content: "系统内容" },
      diff: []
    } as never);
    runtime.store.submitDraftAiWritePlan(conversationId);
    // 尝试在确认请求中夹带篡改内容
    const response = await owner.agent.post(`/api/works/${workId}/ai-write-plans/${String(plan.id)}/approve`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ operations: [{ after: { title: "被篡改的标题" } }], status: "pending" })
      .expect(200);
    expect(response.body.data.status).toBe("executed");
    const settings = runtime.store.listSettings(workId);
    expect(settings).toHaveLength(1);
    expect(String(settings[0]?.title ?? "")).toBe("系统计划");
  });

  it("作品设置拒绝未知的可写工具开关键", async () => {
    const owner = await register("plan_owner");
    const { workId } = await createAuthWork(owner);
    await owner.agent.patch(`/api/works/${workId}/ai-settings`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ writeTools: { characters: true, "unknown-key": true } })
      .expect(400);
    await owner.agent.patch(`/api/works/${workId}/ai-settings`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ writeTools: { characters: true, outlines: false } })
      .expect(200);
    expect(runtime.store.getWorkAiWriteTools(workId).characters).toBe(true);
  });

  it("只有提问发起用户或对话归属用户可以回答提问", async () => {
    const owner = await register("plan_owner");
    const outsider = await register("plan_outsider");
    const { workId } = await createAuthWork(owner);
    const { conversationId } = await createAuthConversation(owner, workId);
    const question = runtime.store.createAiToolQuestion(workId, conversationId, "选择方向？", ["东方", "西方"]);
    await outsider.agent.post(`/api/ai-questions/${String(question.id)}/answer`)
      .set("X-CSRF-Token", outsider.csrfToken).send({ answer: "东方" }).expect(403);
    await owner.agent.post(`/api/ai-questions/${String(question.id)}/answer`)
      .set("X-CSRF-Token", owner.csrfToken).send({ answer: "西方" }).expect(200);
    expect(runtime.store.getAiToolQuestion(String(question.id)).answer).toBe("西方");
  });

  it("非参与者访问待回答提问列表被拒绝", async () => {
    const owner = await register("plan_owner");
    const outsider = await register("plan_outsider");
    const { workId } = await createAuthWork(owner);
    // 授予 outsider 读权限使其能访问作品,但不是提问相关用户
    await owner.agent.post(`/api/works/${workId}/members`).set("X-CSRF-Token", owner.csrfToken).send({
      userId: outsider.user.userId,
      permissions: { prose: "read", settings: "read", characters: "read", races: "read", organizations: "read", timeline: "read", relationships: "read", outlines: "read", drafts: "read", reviews: "read", "ai-chat": "read", "ai-analysis": "read", "ai-settings": "read" }
    }).expect(201);
    const { conversationId } = await createAuthConversation(owner, workId);
    runtime.store.createAiToolQuestion(workId, conversationId, "敏感问题?", ["甲", "乙"]);
    await outsider.agent.get(`/api/works/${workId}/ai-questions?conversationId=${conversationId}`).expect(403);
    const pending = await owner.agent.get(`/api/works/${workId}/ai-questions?conversationId=${conversationId}`).expect(200);
    expect(pending.body.data.question.question).toBe("敏感问题?");
  });

  it("待回答提问可跨请求恢复，回答后注入结果", async () => {
    const owner = await register("plan_owner");
    const { workId } = await createAuthWork(owner);
    const { conversationId } = await createAuthConversation(owner, workId);
    const question = runtime.store.createAiToolQuestion(workId, conversationId, "选择方向？", ["东方", "西方"]);
    const pending = await owner.agent.get(`/api/works/${workId}/ai-questions?conversationId=${conversationId}`).expect(200);
    expect(pending.body.data.question.id).toBe(String(question.id));
    expect(pending.body.data.question.options).toEqual(["东方", "西方"]);
    await owner.agent.post(`/api/ai-questions/${String(question.id)}/reject`)
      .set("X-CSRF-Token", owner.csrfToken).send({}).expect(200);
    const answered = await owner.agent.get(`/api/works/${workId}/ai-questions?conversationId=${conversationId}`).expect(200);
    expect(answered.body.data.question).toBeNull();
  });
});
