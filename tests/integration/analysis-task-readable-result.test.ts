import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime, seedChapter } from "../helpers.js";

function expectNoDatabaseMetadata(value: unknown): void {
  const forbiddenKeys: string[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, nestedValue] of Object.entries(candidate as Record<string, unknown>)) {
      if (["storageTarget", "database", "table", "taskResultTable"].includes(key)) forbiddenKeys.push(key);
      visit(nestedValue);
    }
  };
  visit(value);
  expect(forbiddenKeys).toEqual([]);
  expect(JSON.stringify(value)).not.toMatch(/当前作品 SQLite 数据库|analysis_tasks|result_json|chapter_insights|review_items|timeline_events|ai_suggestions/u);
}

describe("AI 分析任务可读结果", () => {
  let runtime: Runtime | undefined;

  afterEach(() => runtime?.close());

  it("为全部分析类型说明分析结论和实际写入位置", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "八岐大蛇与须佐之男在高天原决裂，此后长期敌对。");
    const workId = String(seeded.work.id);
    const chapterId = String(seeded.chapter.id);
    const orochi = runtime.store.createCharacter(workId, {
      name: "八岐大蛇",
      aliases: ["大蛇"],
      attributes: { identity: "古代蛇神" },
      profile: { summary: "盘踞于出云的强大神祇。" },
      firstChapterId: chapterId
    });
    const susanoo = runtime.store.createCharacter(workId, { name: "须佐之男", firstChapterId: chapterId });
    const timeline = runtime.store.createTimelineEvent(workId, {
      name: "高天原决裂",
      description: "八岐大蛇与须佐之男公开决裂。",
      eventType: "conflict",
      timeLabel: "神代",
      chapterIds: [chapterId],
      participantIds: [String(orochi.id), String(susanoo.id)],
      location: "高天原",
      impactScope: "双方关系"
    }, "analysis", "readable-result-test");
    const setting = runtime.store.createSetting(workId, {
      title: "高天原禁令",
      category: "世界规则",
      content: "神代诸神不得私自干预人间。",
      status: "candidate"
    }, "analysis", "readable-result-test");
    const duplicateReview = runtime.store.createReviewItem(workId, {
      itemType: "character-duplicate",
      severity: "high",
      title: "八岐大蛇与大蛇疑似重复",
      description: "别名与出场证据高度重合。",
      suggestion: "请确认是否合并角色档案。"
    });
    const consistencyReview = runtime.store.createReviewItem(workId, {
      itemType: "setting-conflict",
      severity: "medium",
      title: "禁令与行动冲突",
      description: "角色行为可能违反高天原禁令。",
      suggestion: "补充禁令例外条件。"
    });
    const relationship = runtime.store.createRelationship(workId, {
      fromCharacterId: String(orochi.id),
      toCharacterId: String(susanoo.id),
      category: "conflict",
      subtype: "宿敌",
      keywords: ["长期敌对", "神代冲突"],
      currentStatus: "active",
      confidence: 0.94,
      evidence: [
        { chapterId, chapterTitle: seeded.chapter.title, quote: "此后长期敌对", supports: "明确说明关系持续" },
        { settingId: String(setting.id), settingTitle: String(setting.title), quote: "神代诸神不得私自干预人间。", supports: "设定集补充关系背景" }
      ]
    }, "analysis", "readable-result-test");

    const createCompletedTask = (taskType: string, result: Record<string, unknown>, scope: Record<string, unknown> = { type: "book" }): string => {
      const task = runtime!.store.createTask(workId, { taskType, scope });
      runtime!.store.updateTask(String(task.id), { status: "completed", progress: 100, result });
      return String(task.id);
    };
    const cases = [
      {
        taskId: createCompletedTask("chapter-analysis", {
          insightId: "insight_readable",
          chapterId,
          chapterVersion: seeded.chapter.versionNo,
          summary: "本章确立了八岐大蛇与须佐之男的敌对关系。",
          events: [{ title: "双方决裂", description: "两人在高天原公开决裂。" }],
          characters: [{ name: "八岐大蛇", identity: "冲突发起者" }],
          settings: [{ title: "高天原", description: "诸神活动区域" }],
          evidence: [{ conclusion: "关系转为敌对", quote: "此后长期敌对" }],
          uncertainties: []
        }, { type: "chapter", chapterId }),
        location: `当前作品 · ${seeded.chapter.title}`,
        sectionTitle: "情节事件",
        itemTitle: "双方决裂"
      },
      {
        taskId: createCompletedTask("character-extraction", {
          characterIds: [orochi.id],
          candidateCount: 1,
          coveredChapterCount: 1,
          skipped: [],
          verification: { pairCount: 0 }
        }),
        location: "当前作品 · 角色库",
        sectionTitle: "保存的角色",
        itemTitle: "八岐大蛇"
      },
      {
        taskId: createCompletedTask("character-summary", {
          characterIds: [orochi.id],
          candidateCount: 1,
          coveredChapterCount: 1,
          skipped: [],
          verification: { pairCount: 0 }
        }),
        location: "当前作品 · 角色库",
        sectionTitle: "保存的角色",
        itemTitle: "八岐大蛇"
      },
      {
        taskId: createCompletedTask("character-identity-audit", {
          characterCount: 2,
          candidateCount: 1,
          reviewIds: [duplicateReview.id],
          skipped: [{
            pair: `${orochi.id}@${orochi.versionNo}|${susanoo.id}@${susanoo.versionNo}`,
            reason: "结论或置信度不足"
          }],
          toolCallCount: 3
        }),
        location: "当前作品 · 审核中心",
        sectionTitle: "角色查重建议",
        itemTitle: "八岐大蛇与大蛇疑似重复",
        skippedItemText: ["八岐大蛇 ↔ 须佐之男", "别名：大蛇", "身份：古代蛇神", "结论或置信度不足"]
      },
      {
        taskId: createCompletedTask("timeline-analysis", { eventIds: [timeline.id], candidateCount: 1 }),
        location: "当前作品 · 时间轴与事件",
        sectionTitle: "事件候选",
        itemTitle: "高天原决裂"
      },
      {
        taskId: createCompletedTask("relationship-analysis", {
          relationshipIds: [relationship.id],
          createdCount: 1,
          updatedCount: 0,
          unchangedCount: 0,
          analysisTarget: { mode: "targeted-characters", characterNames: ["八岐大蛇"], coveredChapterCount: 1 },
          skipped: []
        }, { type: "book", characterIds: [String(orochi.id)] }),
        location: "当前作品 · 人物关系库",
        sectionTitle: "分析出的关系",
        itemTitle: "八岐大蛇"
      },
      {
        taskId: createCompletedTask("worldview-analysis", {
          summary: "高天原以禁令维持神与人间的边界。",
          dimensions: [{ category: "规则与限制", title: "神界干预边界", conclusion: "诸神不得私自干预人间。", confidence: 0.88 }],
          conflicts: [],
          uncertainties: [],
          dimensionCount: 1,
          coveredChapterCount: 1
        }),
        location: "当前作品 · AI 分析记录",
        sectionTitle: "世界观结论",
        itemTitle: "神界干预边界"
      },
      {
        taskId: createCompletedTask("setting-extraction", {
          settingIds: [setting.id],
          rawCandidateCount: 1,
          createdCount: 1,
          updatedCount: 0,
          coveredChapterCount: 1,
          skipped: []
        }),
        location: "当前作品 · 设定库",
        sectionTitle: "写入的设定",
        itemTitle: "高天原禁令"
      },
      {
        taskId: createCompletedTask("consistency-check", { reviewIds: [consistencyReview.id], issueCount: 1 }),
        location: "当前作品 · 审核中心",
        sectionTitle: "一致性问题",
        itemTitle: "禁令与行动冲突"
      },
      {
        taskId: createCompletedTask("book-analysis", { content: "全书主线围绕神代秩序破裂展开。" }),
        location: "当前作品 · AI 分析记录",
        sectionTitle: undefined,
        itemTitle: undefined
      },
      {
        taskId: createCompletedTask("structure", { content: "故事以决裂为转折点，进入冲突阶段。" }),
        location: "当前作品 · AI 分析记录",
        sectionTitle: undefined,
        itemTitle: undefined
      },
      {
        taskId: createCompletedTask("report-update", { content: "分析报告已根据最新章节更新。" }),
        location: "当前作品 · AI 分析记录",
        sectionTitle: undefined,
        itemTitle: undefined
      }
    ];

    for (const item of cases) {
      const response = await request(runtime.app).get(`/api/tasks/${item.taskId}/detail`).expect(200);
      expect(response.body.data).not.toHaveProperty("result");
      expect(response.body.data.hasResult).toBe(true);
      expect(response.body.data.resultSummary.analysisContent).toContain("范围：");
      expect(response.body.data.resultSummary.summary).toEqual(expect.any(String));
      expect(response.body.data.resultSummary.storageTargets).toEqual(expect.arrayContaining([
        expect.objectContaining({ location: item.location })
      ]));
      expect(response.body.data.resultSummary.storageTargets).toEqual(expect.arrayContaining([
        expect.objectContaining({ location: "当前作品 · AI 分析记录", note: expect.stringContaining("可按需查看") })
      ]));
      expectNoDatabaseMetadata(response.body.data);
      if (item.sectionTitle && item.itemTitle) {
        const section = response.body.data.resultSummary.sections.find((candidate: { title: string }) => candidate.title === item.sectionTitle);
        expect(section).toBeTruthy();
        expect(JSON.stringify(section.items)).toContain(item.itemTitle);
        if (item.location === "当前作品 · 人物关系库") {
          expect(JSON.stringify(section.items)).toContain("持续中");
          expect(JSON.stringify(section.items)).toContain("待确认");
          const relationshipItem = section.items.find((candidate: { title: string }) => candidate.title.includes("八岐大蛇"));
          expect(relationshipItem.evidence).toEqual(expect.arrayContaining([
            expect.objectContaining({ sourceType: "chapter", sourceId: chapterId, sourceTitle: seeded.chapter.title }),
            expect.objectContaining({ sourceType: "setting", sourceId: String(setting.id), sourceTitle: String(setting.title), settingId: String(setting.id) })
          ]));
        }
      }
      if ("skippedItemText" in item && item.skippedItemText) {
        const skippedSection = response.body.data.resultSummary.sections.find((candidate: { title: string }) => candidate.title === "未生成建议的候选");
        expect(skippedSection).toBeTruthy();
        for (const expectedText of item.skippedItemText) expect(JSON.stringify(skippedSection.items)).toContain(expectedText);
        expect(JSON.stringify(skippedSection.items)).not.toContain(String(orochi.id));
        expect(JSON.stringify(skippedSection.items)).not.toContain(String(susanoo.id));
      }
    }
  });

  it("详情接口不传输原始结果，完整 JSON 接口按需返回且不截断", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime);
    const workId = String(seeded.work.id);
    const longValue = "完整结果内容".repeat(3_000);
    const originalResult = {
      content: "全书综合分析结论",
      longValue,
      nested: {
        retained: true,
        database: "当前作品 SQLite 数据库",
        table: "analysis_tasks"
      },
      storageTarget: {
        database: "当前作品 SQLite 数据库",
        table: "analysis_tasks",
        taskResultTable: "analysis_tasks"
      }
    };
    const publicResult = { content: "全书综合分析结论", longValue, nested: { retained: true } };
    const task = runtime.store.createTask(workId, { taskType: "book-analysis", scope: { type: "book" } });
    runtime.store.updateTask(String(task.id), { status: "completed", progress: 100, result: originalResult });

    const databaseGet = vi.spyOn(runtime.store.db, "get");
    const detail = await request(runtime.app).get(`/api/tasks/${task.id}/detail`).expect(200);
    expect(detail.body.data).not.toHaveProperty("result");
    expect(JSON.stringify(detail.body.data)).not.toContain(longValue);
    expect(databaseGet.mock.calls.filter(([sql]) => String(sql).includes("FROM analysis_tasks WHERE id = ?"))).toHaveLength(1);
    expectNoDatabaseMetadata(detail.body.data);

    databaseGet.mockClear();
    const fullResult = await request(runtime.app).get(`/api/tasks/${task.id}/result`).expect(200);
    expect(fullResult.body.data).toEqual({ taskId: task.id, result: publicResult });
    expect(fullResult.body.data.result.longValue).toHaveLength(longValue.length);
    expectNoDatabaseMetadata(fullResult.body.data);
    expect(databaseGet.mock.calls.filter(([sql]) => String(sql).includes("FROM analysis_tasks WHERE id = ?"))).toHaveLength(1);

    databaseGet.mockClear();
    await request(runtime.app).get(`/api/tasks/${task.id}/trace`).expect(200);
    const traceTaskQueries = databaseGet.mock.calls.filter(([sql]) => String(sql).includes("FROM analysis_tasks WHERE id = ?"));
    expect(traceTaskQueries).toHaveLength(1);
    expect(String(traceTaskQueries[0]?.[0])).toContain("SELECT work_id");
  });

  it("兼容主库历史任务结构并说明选定内容和现存数据差异", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "八岐大蛇在神代引发大战。");
    const workId = String(seeded.work.id);
    const timeline = runtime.store.createTimelineEvent(workId, {
      name: "神代大战",
      description: "八岐大蛇引发大战。",
      eventType: "conflict",
      timeLabel: "神代",
      chapterIds: [String(seeded.chapter.id)],
      participantIds: [],
      location: "高天原",
      impactScope: "神界"
    }, "analysis", "legacy-readable-result-test");
    const from = runtime.store.createCharacter(workId, { name: "八岐大蛇", firstChapterId: String(seeded.chapter.id) });
    const to = runtime.store.createCharacter(workId, { name: "须佐之男", firstChapterId: String(seeded.chapter.id) });
    const relationship = runtime.store.createRelationship(workId, {
      fromCharacterId: String(from.id),
      toCharacterId: String(to.id),
      category: "conflict",
      subtype: "宿敌"
    }, "analysis", "legacy-readable-result-test");
    const createCompletedTask = (taskType: string, result: Record<string, unknown>, selection: string): string => {
      const task = runtime!.store.createTask(workId, { taskType, scope: { type: "selection", selection } });
      runtime!.store.updateTask(String(task.id), { status: "completed", progress: 100, result });
      return String(task.id);
    };

    const legacyConsistencyTaskId = createCompletedTask("consistency-check", {
      relationships: 97,
      confirmed: 72,
      pending: 25,
      mergedCanonicalIds: [relationship.id],
      semanticCorrections: ["八岐大蛇与须佐之男"]
    }, "人物关系重复、方向与语义最终审计");
    const consistencyDetail = await request(runtime.app).get(`/api/tasks/${legacyConsistencyTaskId}/detail`).expect(200);
    expect(consistencyDetail.body.data.scopeSummary).toContain("选定内容：人物关系重复、方向与语义最终审计");
    expect(consistencyDetail.body.data.scopeDetails).toEqual([
      { type: "selection", selection: "人物关系重复、方向与语义最终审计" }
    ]);
    expect(consistencyDetail.body.data.resultSummary.summary).toContain("审核 97 条人物关系");
    expect(consistencyDetail.body.data.resultSummary.summary).toContain("72 条已确认");
    expect(consistencyDetail.body.data.resultSummary.storageTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ location: "当前作品 · 人物关系库", count: 2 })
    ]));
    expect(JSON.stringify(consistencyDetail.body.data.resultSummary.sections)).toContain("八岐大蛇与须佐之男");

    const legacyBookTaskId = createCompletedTask("book-analysis", {
      sourceChapterCount: 299,
      sourceChunkCount: 30,
      eventCount: 1,
      eventIds: [timeline.id]
    }, "全文时间线按正文顺序重建：299章全覆盖");
    const bookDetail = await request(runtime.app).get(`/api/tasks/${legacyBookTaskId}/detail`).expect(200);
    expect(bookDetail.body.data.resultSummary.summary).toContain("分析 299 章正文");
    expect(bookDetail.body.data.resultSummary.storageTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ location: "当前作品 · 时间轴与事件", count: 1 })
    ]));
    expect(JSON.stringify(bookDetail.body.data.resultSummary.sections)).toContain("神代大战");

    const legacyCharacterRepairTaskId = createCompletedTask("book-analysis", {
      correctedCharacterIds: [from.id],
      removedDuplicateCharacterIds: ["character_removed"],
      evidence: [{ chapterId: seeded.chapter.id, quote: "八岐大蛇在神代引发大战。" }]
    }, "人物档案补充人工核验");
    const characterRepairDetail = await request(runtime.app).get(`/api/tasks/${legacyCharacterRepairTaskId}/detail`).expect(200);
    expect(characterRepairDetail.body.data.resultSummary.summary).toContain("修正 1 个角色，并移除 1 个重复角色档案");
    expect(characterRepairDetail.body.data.resultSummary.storageTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ location: "当前作品 · 角色库", count: 2 })
    ]));
    expect(JSON.stringify(characterRepairDetail.body.data.resultSummary.sections)).toContain("八岐大蛇");

    const resumableBookTaskId = createCompletedTask("book-analysis", {
      resumable: true,
      sourceChapterCount: 299,
      sourceChunkCount: 20,
      completedChunkCount: 20,
      chunkResults: [{ chunk: 1 }]
    }, "全文联合知识分析");
    const resumableBookDetail = await request(runtime.app).get(`/api/tasks/${resumableBookTaskId}/detail`).expect(200);
    expect(resumableBookDetail.body.data.resultSummary.summary).toBe("已完成 20/20 个正文分段的阶段分析，当前结果可继续处理。");
    expect(resumableBookDetail.body.data.resultSummary.metrics).toEqual(expect.arrayContaining([
      { label: "可继续处理", value: "是" },
      { label: "已完成分段", value: 20 },
      { label: "分段结果", value: 1 }
    ]));

    const legacyRelationshipTaskId = createCompletedTask("relationship-analysis", {
      relationshipIds: [relationship.id, "relationship_deleted"],
      skipped: []
    }, "人物长期关系分析");
    const relationshipDetail = await request(runtime.app).get(`/api/tasks/${legacyRelationshipTaskId}/detail`).expect(200);
    expect(relationshipDetail.body.data.resultSummary.summary).toContain("任务结果记录 2 条关系");
    expect(relationshipDetail.body.data.resultSummary.summary).toContain("另有 1 条已删除或合并");
    expect(relationshipDetail.body.data.resultSummary.storageTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ location: "当前作品 · 人物关系库", count: 2, note: expect.stringContaining("当前可读取 1 条") })
    ]));
    [consistencyDetail, bookDetail, characterRepairDetail, resumableBookDetail, relationshipDetail]
      .forEach((response) => expectNoDatabaseMetadata(response.body.data));
  });
});
