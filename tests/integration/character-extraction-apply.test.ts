import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime, seedChapter } from "../helpers.js";

type Candidate = {
  candidateId: string;
  name: string;
  aliases?: string[];
  species?: string;
  identity?: string;
  firstChapterId?: string | null;
  firstEvidence?: { chapterId: string; chapterTitle: string; quote: string } | null;
  stableCharacterId?: string | null;
};

function completeExtractionTask(runtime: Runtime, workId: string, candidates: Candidate[], status = "completed"): string {
  const task = runtime.store.createTask(workId, { taskType: "character-extraction", scope: { type: "book" } });
  runtime.store.updateTask(String(task.id), {
    status,
    progress: 100,
    result: {
      characterIds: [],
      characterCandidates: candidates.map((candidate) => ({
        aliases: [],
        species: "",
        identity: "",
        firstChapterId: null,
        firstEvidence: null,
        stableCharacterId: null,
        ...candidate
      })),
      candidateCount: candidates.length,
      savedCount: 0,
      skipped: [],
      characterApplication: { status: "pending", totalCount: candidates.length, generatedAt: new Date().toISOString() }
    }
  });
  return String(task.id);
}

describe("角色抽取结果预览与应用 API", () => {
  let runtime: Runtime;

  afterEach(() => runtime.close());

  it("按用户确认新建、合并或跳过，并以同一请求幂等返回应用结果", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "林舟抵达北港，沈月随后出现。");
    const workId = String(seeded.work.id);
    const existing = runtime.store.createCharacter(workId, {
      name: "林舟",
      aliases: ["小舟"],
      attributes: { identity: "既有主角身份" }
    });
    const taskId = completeExtractionTask(runtime, workId, [
      {
        candidateId: "candidate-1",
        name: "林舟",
        aliases: ["船长"],
        identity: "AI 推断的新身份",
        firstChapterId: String(seeded.chapter.id),
        firstEvidence: { chapterId: String(seeded.chapter.id), chapterTitle: String(seeded.chapter.title), quote: "林舟抵达北港" },
        stableCharacterId: String(existing.id)
      },
      {
        candidateId: "candidate-2",
        name: "沈月",
        aliases: ["月姐"],
        species: "未建档种族",
        identity: "通讯员",
        firstChapterId: String(seeded.chapter.id),
        firstEvidence: { chapterId: String(seeded.chapter.id), chapterTitle: String(seeded.chapter.title), quote: "沈月随后出现" }
      },
      {
        candidateId: "candidate-3",
        name: "小林",
        aliases: ["小舟"],
        identity: "疑似同一人"
      }
    ]);

    const preview = await request(runtime.app).get(`/api/tasks/${taskId}/character-extraction/preview`).expect(200);
    expect(preview.body.data).toMatchObject({ status: "pending", totalCount: 3, previewToken: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(preview.body.data.items[0]).toMatchObject({
      candidateId: "candidate-1",
      suggestedAction: "merge",
      matchCandidates: [{ characterId: existing.id, matchType: "stable" }]
    });
    expect(preview.body.data.items[1]).toMatchObject({ candidateId: "candidate-2", suggestedAction: "create", matchCandidates: [] });
    expect(preview.body.data.items[2]).toMatchObject({
      candidateId: "candidate-3",
      suggestedAction: "merge",
      matchCandidates: [{ characterId: existing.id }]
    });

    const payload = {
      previewToken: preview.body.data.previewToken,
      selections: [
        {
          candidateId: "candidate-1",
          action: "merge",
          targetCharacterId: existing.id,
          name: "林舟",
          aliases: ["船长"],
          attributes: { identity: "AI 推断的新身份" }
        },
        {
          candidateId: "candidate-2",
          action: "create",
          name: "沈月",
          aliases: ["月姐"],
          species: "未建档种族",
          attributes: { identity: "通讯员" }
        },
        { candidateId: "candidate-3", action: "skip" }
      ]
    };
    const applied = await request(runtime.app).post(`/api/tasks/${taskId}/character-extraction/apply`).send(payload).expect(200);
    expect(applied.body.data).toMatchObject({
      status: "applied",
      totalCount: 3,
      createdCount: 1,
      mergedCount: 1,
      unchangedCount: 0,
      skippedCount: 1
    });
    expect(applied.body.data.items[0]).toMatchObject({
      status: "merged",
      characterId: existing.id,
      addedAliases: ["船长"],
      conflicts: ["已有身份与定位内容未被抽取结果覆盖"]
    });
    expect(applied.body.data.items[1].conflicts).toContain("种族“未建档种族”未命中当前作品已有种族，未写入种族关联");

    const characters = runtime.store.listCharacters(workId);
    expect(characters).toHaveLength(2);
    expect(characters.find((character) => character.id === existing.id)).toMatchObject({
      name: "林舟",
      aliases: ["小舟", "船长"],
      attributes: { identity: "既有主角身份" }
    });
    const created = characters.find((character) => character.name === "沈月");
    expect(created).toMatchObject({ aliases: ["月姐"], attributes: { identity: "通讯员" }, firstChapterId: seeded.chapter.id });
    const versions = runtime.store.listCharacterVersions(String(created?.id));
    expect(versions[0]).toMatchObject({ source: "ai", sourceRef: taskId, changeNote: "应用 AI 角色抽取预览并新建档案" });

    const repeated = await request(runtime.app).post(`/api/tasks/${taskId}/character-extraction/apply`).send(payload).expect(200);
    expect(repeated.body.data).toEqual(applied.body.data);
    expect(runtime.store.listCharacters(workId)).toHaveLength(2);
    const applicationAudits = runtime.database.all(
      "SELECT id FROM audit_logs WHERE work_id = ? AND action = 'character.extraction.applied' AND entity_id = ?",
      workId,
      taskId
    );
    expect(applicationAudits).toHaveLength(1);
    const storedResult = runtime.store.getTaskStoredResult(taskId);
    expect(storedResult.characterCandidates).toHaveLength(3);
    expect(storedResult.characterApplication).toMatchObject({ status: "applied", createdCount: 1, mergedCount: 1 });

    await request(runtime.app).post(`/api/tasks/${taskId}/character-extraction/apply`).send({
      ...payload,
      selections: payload.selections.map((selection) => selection.candidateId === "candidate-3"
        ? { ...selection, action: "create", name: "小林" }
        : selection)
    }).expect(409);
  });

  it("任一候选冲突时整体回滚，过期预览也不会留下半套档案", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime);
    const workId = String(seeded.work.id);
    const existing = runtime.store.createCharacter(workId, { name: "已有角色" });
    const taskId = completeExtractionTask(runtime, workId, [
      { candidateId: "candidate-1", name: "可创建角色" },
      { candidateId: "candidate-2", name: "已有角色" }
    ]);
    const preview = await request(runtime.app).get(`/api/tasks/${taskId}/character-extraction/preview`).expect(200);
    const response = await request(runtime.app).post(`/api/tasks/${taskId}/character-extraction/apply`).send({
      previewToken: preview.body.data.previewToken,
      selections: [
        { candidateId: "candidate-1", action: "create", name: "可创建角色" },
        { candidateId: "candidate-2", action: "create", name: "已有角色" }
      ]
    }).expect(409);
    expect(response.body.error.code).toBe("CHARACTER_NAME_CONFLICT");
    expect(runtime.store.listCharacters(workId).map((character) => character.name)).toEqual(["已有角色"]);
    expect(runtime.store.getTaskStoredResult(taskId).characterApplication).toMatchObject({ status: "pending" });

    const staleTaskId = completeExtractionTask(runtime, workId, [{ candidateId: "candidate-1", name: "新角色" }]);
    const stalePreview = await request(runtime.app).get(`/api/tasks/${staleTaskId}/character-extraction/preview`).expect(200);
    runtime.store.updateCharacter(String(existing.id), { aliases: ["旧称"] }, "manual", null, "并发修改");
    const stale = await request(runtime.app).post(`/api/tasks/${staleTaskId}/character-extraction/apply`).send({
      previewToken: stalePreview.body.data.previewToken,
      selections: [{ candidateId: "candidate-1", action: "create", name: "新角色" }]
    }).expect(409);
    expect(stale.body.error.code).toBe("CHARACTER_EXTRACTION_PREVIEW_STALE");
    expect(runtime.store.listCharacters(workId).map((character) => character.name)).toEqual(["已有角色"]);
  });

  it("并发重复确认只创建一次，并拒绝未完成任务、错误类型和非预览目标", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime);
    const workId = String(seeded.work.id);
    const taskId = completeExtractionTask(runtime, workId, [{ candidateId: "candidate-1", name: "并发角色" }]);
    const preview = await request(runtime.app).get(`/api/tasks/${taskId}/character-extraction/preview`).expect(200);
    const payload = {
      previewToken: preview.body.data.previewToken,
      selections: [{ candidateId: "candidate-1", action: "create", name: "并发角色" }]
    };
    const [first, second] = await Promise.all([
      request(runtime.app).post(`/api/tasks/${taskId}/character-extraction/apply`).send(payload),
      request(runtime.app).post(`/api/tasks/${taskId}/character-extraction/apply`).send(payload)
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(runtime.store.listCharacters(workId).filter((character) => character.name === "并发角色")).toHaveLength(1);

    const pending = runtime.store.createTask(workId, { taskType: "character-extraction", scope: { type: "book" } });
    const pendingResponse = await request(runtime.app).get(`/api/tasks/${pending.id}/character-extraction/preview`).expect(409);
    expect(pendingResponse.body.error.code).toBe("CHARACTER_EXTRACTION_TASK_NOT_COMPLETED");
    const other = runtime.store.createTask(workId, { taskType: "book-analysis", scope: { type: "book" } });
    runtime.store.updateTask(String(other.id), { status: "completed", result: { characterCandidates: [] } });
    const otherResponse = await request(runtime.app).get(`/api/tasks/${other.id}/character-extraction/preview`).expect(409);
    expect(otherResponse.body.error.code).toBe("CHARACTER_EXTRACTION_TASK_REQUIRED");

    const target = runtime.store.createCharacter(workId, { name: "无关目标" });
    const targetTaskId = completeExtractionTask(runtime, workId, [{ candidateId: "candidate-1", name: "全新候选" }]);
    const targetPreview = await request(runtime.app).get(`/api/tasks/${targetTaskId}/character-extraction/preview`).expect(200);
    const invalidTarget = await request(runtime.app).post(`/api/tasks/${targetTaskId}/character-extraction/apply`).send({
      previewToken: targetPreview.body.data.previewToken,
      selections: [{ candidateId: "candidate-1", action: "merge", targetCharacterId: target.id }]
    }).expect(400);
    expect(invalidTarget.body.error.code).toBe("CHARACTER_EXTRACTION_TARGET_INVALID");
    await request(runtime.app).post(`/api/tasks/${targetTaskId}/character-extraction/apply`).send({
      previewToken: targetPreview.body.data.previewToken,
      selections: [{ candidateId: "candidate-1", action: "skip", internalPrompt: "不可写入" }]
    }).expect(400);
  });
});
