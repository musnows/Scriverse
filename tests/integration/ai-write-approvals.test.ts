import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

function parseSseEvents(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  return text.split(/\r?\n\r?\n/u).flatMap((chunk) => {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of chunk.split(/\r?\n/u)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return [];
    return [{ event: eventName, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> }];
  });
}

describe("侧边栏 AI 可写工具与审批", () => {
  let runtime: Runtime;
  let workId: string;
  let chapterId: string;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(async () => {
    fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "已记录。" } }] }), { status: 200 });
    });
    runtime = createTestRuntime(fetchMock);
    const work = await request(runtime.app).post("/api/works").send({ title: "可写工具作品" });
    workId = work.body.data.id;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" });
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "林舟启动了飞船。\n冷却计时仍在继续。"
    });
    chapterId = chapter.body.data.id;
  });

  afterEach(() => {
    runtime.close();
  });

  async function configureAi(): Promise<string> {
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "本地兼容服务",
      baseUrl: "https://mock-ai.test/v1/chat/completions",
      apiKey: "sk-sensitive-test-value",
      status: "enabled"
    }).expect(201);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "小说模型",
      modelId: "mock-novel-model"
    }).expect(201);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    return model.body.data.id as string;
  }

  it("默认可写工具关闭，开启后才能提交修改计划并原子执行", async () => {
    const modelId = await configureAi();
    const settings = await request(runtime.app).get(`/api/works/${workId}/ai-settings`).expect(200);
    expect(settings.body.data.agentTools).not.toContain("write_settings");
    expect(settings.body.data.agentTools).not.toContain("ask_user_questions");

    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentTools: [...settings.body.data.agentTools, "write_settings", "write_chapter_annotations", "write_analysis_tasks", "ask_user_questions"]
    }).expect(200);

    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = conversation.body.data.id as string;
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as { tool_choice?: string };
      if (completionCount === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: "我先提交设定修改。",
              tool_calls: [{
                id: "write-setting",
                type: "function",
                function: {
                  name: "write_settings",
                  arguments: JSON.stringify({
                    summary: "补充跃迁冷却设定",
                    operations: [{
                      kind: "create_setting",
                      fields: { title: "跃迁冷却", category: "世界规则", content: "跃迁后必须冷却十二小时。" }
                    }]
                  })
                }
              }]
            }
          }]
        }), { status: 200 });
      }
      expect(body.tool_choice).toBe("none");
      return new Response(JSON.stringify({ choices: [{ message: { content: "已提交修改计划，请确认。" } }] }), { status: 200 });
    });

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "请新增跃迁冷却设定。",
      scope: { type: "none" },
      modelId,
      conversationId
    }).expect(200);

    expect(streamed.text).toContain("event: write_approval");
    const events = parseSseEvents(streamed.text);
    const approvalEvent = events.find((item) => item.event === "write_approval");
    expect(approvalEvent?.data.status).toBe("pending");
    const approvalId = String(approvalEvent?.data.id);
    const operations = approvalEvent?.data.operations as Array<Record<string, unknown>>;
    expect(operations[0]?.actionLabel).toBe("新增");
    expect(operations[0]?.diffs).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "title", after: "跃迁冷却" })
    ]));

    const before = await request(runtime.app).get(`/api/works/${workId}/settings`).expect(200);
    const beforeList = before.body.data.items ?? before.body.data;
    expect(Array.isArray(beforeList) ? beforeList.find((item: { title: string }) => item.title === "跃迁冷却") : undefined).toBeUndefined();

    const confirmed = await request(runtime.app).post(`/api/ai-write-approvals/${approvalId}/confirm`).send({}).expect(200);
    expect(confirmed.body.data.status).toBe("succeeded");
    expect(confirmed.body.data.operations[0].result.versionNo).toBeGreaterThan(0);
    expect(confirmed.body.data.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "ai-write-approval.executed" }),
      expect.objectContaining({ action: "setting.created" })
    ]));

    const after = await request(runtime.app).get(`/api/works/${workId}/settings`).expect(200);
    const created = (after.body.data.items ?? after.body.data).find((item: { title: string }) => item.title === "跃迁冷却");
    expect(created).toBeTruthy();

    const again = await request(runtime.app).post(`/api/ai-write-approvals/${approvalId}/confirm`).send({}).expect(200);
    expect(again.body.data.status).toBe("succeeded");
    const settingsAfterRetry = await request(runtime.app).get(`/api/works/${workId}/settings`).expect(200);
    const matches = (settingsAfterRetry.body.data.items ?? settingsAfterRetry.body.data).filter((item: { title: string }) => item.title === "跃迁冷却");
    expect(matches).toHaveLength(1);

    await request(runtime.app).post(`/api/ai-write-approvals/${approvalId}/confirm`).send({ title: "伪造字段" }).expect(400);
  });

  it("正文批注不改变章节正文，分析任务进入既有队列", async () => {
    const modelId = await configureAi();
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentTools: ["write_chapter_annotations", "write_analysis_tasks"]
    }).expect(200);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      completionCount += 1;
      if (completionCount === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              tool_calls: [
                {
                  id: "note-1",
                  type: "function",
                  function: {
                    name: "write_chapter_annotations",
                    arguments: JSON.stringify({
                      summary: "给第一行加评论",
                      operations: [{
                        kind: "create_chapter_annotation",
                        fields: { chapterId, kind: "note", startLine: 1, endLine: 1, note: "这里可以强调冷却。" }
                      }]
                    })
                  }
                },
                {
                  id: "task-1",
                  type: "function",
                  function: {
                    name: "write_analysis_tasks",
                    arguments: JSON.stringify({
                      summary: "运行全书结构分析",
                      operations: [{
                        kind: "create_analysis_task",
                        fields: { taskType: "structure", modelId, scope: { type: "book" } }
                      }]
                    })
                  }
                }
              ]
            }
          }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "请确认批注和分析任务。" } }] }), { status: 200 });
    });

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "给正文加评论并创建结构分析。",
      scope: { type: "none" },
      modelId,
      conversationId: conversation.body.data.id
    }).expect(200);
    const approvalId = String(parseSseEvents(streamed.text).find((item) => item.event === "write_approval")?.data.id);
    const detail = await request(runtime.app).get(`/api/ai-write-approvals/${approvalId}`).expect(200);
    expect(detail.body.data.operations).toHaveLength(2);
    expect(detail.body.data.operations[0].annotation.quote).toContain("林舟启动了飞船。");
    expect(detail.body.data.operations[1].analysisTask.taskType).toBe("structure");
    expect(detail.body.data.operations[1].analysisTask.modelId).toBe(modelId);

    const chapterBefore = await request(runtime.app).get(`/api/chapters/${chapterId}`).expect(200);
    await request(runtime.app).post(`/api/ai-write-approvals/${approvalId}/confirm`).send({}).expect(200);
    const chapterAfter = await request(runtime.app).get(`/api/chapters/${chapterId}`).expect(200);
    expect(chapterAfter.body.data.content).toBe(chapterBefore.body.data.content);
    expect(chapterAfter.body.data.title).toBe(chapterBefore.body.data.title);
    expect(chapterAfter.body.data.volumeId).toBe(chapterBefore.body.data.volumeId);

    const annotations = await request(runtime.app).get(`/api/chapters/${chapterId}/annotations`).expect(200);
    expect(annotations.body.data.items ?? annotations.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "note", note: "这里可以强调冷却。" })
    ]));
    const tasks = await request(runtime.app).get(`/api/works/${workId}/tasks`).expect(200);
    expect(tasks.body.data.items ?? tasks.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskType: "structure", status: "pending" })
    ]));
  });

  it("跨作品对象、关闭工具和超限计划都不会写入", async () => {
    const modelId = await configureAi();
    const otherWork = await request(runtime.app).post("/api/works").send({ title: "另一部作品" });
    const otherSetting = await request(runtime.app).post(`/api/works/${otherWork.body.data.id}/settings`).send({
      title: "外部设定",
      category: "规则",
      content: "不属于当前作品。"
    }).expect(201);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentTools: ["write_settings"]
    }).expect(200);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      completionCount += 1;
      if (completionCount === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              tool_calls: [{
                id: "cross-work",
                type: "function",
                function: {
                  name: "write_settings",
                  arguments: JSON.stringify({
                    summary: "改外部设定",
                    operations: [{
                      kind: "update_setting",
                      targetId: otherSetting.body.data.id,
                      fields: { content: "试图跨作品修改" }
                    }]
                  })
                }
              }]
            }
          }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "无法跨作品修改。" } }] }), { status: 200 });
    });
    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "修改外部设定。",
      scope: { type: "none" },
      modelId,
      conversationId: conversation.body.data.id
    }).expect(200);
    expect(streamed.text).not.toContain("event: write_approval");
    expect(streamed.text).toContain("AI_WRITE_TARGET_WORK_MISMATCH");

    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    const pending = await request(runtime.app).get(`/api/works/${workId}/ai-write-approvals`).expect(200);
    expect(pending.body.data.items ?? pending.body.data).toEqual([]);

    const original = process.env.AI_WRITE_PLAN_MAX_OPERATIONS;
    process.env.AI_WRITE_PLAN_MAX_OPERATIONS = "21";
    try {
      expect(() => runtime.ai.writeApprovals.submitPlan({
        workId,
        conversationId: conversation.body.data.id,
        summary: "超限",
        operations: [{ kind: "create_setting", fields: { title: "A", category: "规则", content: "x" } }],
        enabledToolIds: ["write_settings"]
      })).toThrow(/1 到 20/);
    } finally {
      if (original === undefined) delete process.env.AI_WRITE_PLAN_MAX_OPERATIONS;
      else process.env.AI_WRITE_PLAN_MAX_OPERATIONS = original;
    }
  });

  it("AskUserQuestions 会持久化提问且未回答时不会伪造答案", async () => {
    const modelId = await configureAi();
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentTools: ["ask_user_questions"]
    }).expect(200);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      completionCount += 1;
      if (completionCount === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              tool_calls: [{
                id: "ask-1",
                type: "function",
                function: {
                  name: "AskUserQuestions",
                  arguments: JSON.stringify({
                    question: "是否沿用现有冷却规则？",
                    options: [{ id: "keep", label: "沿用" }, { id: "rewrite", label: "重写" }]
                  })
                }
              }]
            }
          }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "请先选择一个选项。" } }] }), { status: 200 });
    });
    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "冷却规则怎么处理？",
      scope: { type: "none" },
      modelId,
      conversationId: conversation.body.data.id
    }).expect(200);
    expect(streamed.text).toContain("event: ask_user_question");
    const question = parseSseEvents(streamed.text).find((item) => item.event === "ask_user_question")?.data;
    expect(question?.status).toBe("pending");
    expect((question?.options as Array<{ label: string }>)[0]?.label).toContain("（最推荐）");
    const listed = await request(runtime.app).get(`/api/works/${workId}/ai-user-questions`).expect(200);
    expect(listed.body.data.items ?? listed.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: question?.id, status: "pending" })
    ]));
  });

  it("关闭可写工具后待确认审批会失效且不会写入", async () => {
    const modelId = await configureAi();
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentTools: ["write_settings"]
    }).expect(200);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      completionCount += 1;
      if (completionCount === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              tool_calls: [{
                id: "write-setting",
                type: "function",
                function: {
                  name: "write_settings",
                  arguments: JSON.stringify({
                    summary: "补充冷却设定",
                    operations: [{
                      kind: "create_setting",
                      fields: { title: "冷却规则", category: "世界规则", content: "必须冷却。" }
                    }]
                  })
                }
              }]
            }
          }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "请确认。" } }] }), { status: 200 });
    });
    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "新增冷却规则。",
      scope: { type: "none" },
      modelId,
      conversationId: conversation.body.data.id
    }).expect(200);
    const approvalId = String(parseSseEvents(streamed.text).find((item) => item.event === "write_approval")?.data.id);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    const failed = await request(runtime.app).post(`/api/ai-write-approvals/${approvalId}/confirm`).send({}).expect(409);
    expect(failed.body.error.code).toBe("AI_WRITE_APPROVAL_INVALIDATED");
    const settings = await request(runtime.app).get(`/api/works/${workId}/settings`).expect(200);
    const list = settings.body.data.items ?? settings.body.data;
    expect(Array.isArray(list) ? list.find((item: { title: string }) => item.title === "冷却规则") : undefined).toBeUndefined();
  });

  it("编辑词条确认后可撤销，新建词条不能通过撤销删除", async () => {
    const modelId = await configureAi();
    const setting = await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "原有冷却",
      category: "世界规则",
      content: "冷却六小时。"
    }).expect(201);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentTools: ["write_settings"]
    }).expect(200);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      completionCount += 1;
      if (completionCount === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              tool_calls: [{
                id: "update-setting",
                type: "function",
                function: {
                  name: "write_settings",
                  arguments: JSON.stringify({
                    summary: "把冷却改成十二小时",
                    operations: [{
                      kind: "update_setting",
                      targetId: setting.body.data.id,
                      fields: { content: "冷却十二小时。" }
                    }]
                  })
                }
              }]
            }
          }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "请确认修改。" } }] }), { status: 200 });
    });
    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "把冷却改成十二小时。",
      scope: { type: "none" },
      modelId,
      conversationId: conversation.body.data.id
    }).expect(200);
    const approvalId = String(parseSseEvents(streamed.text).find((item) => item.event === "write_approval")?.data.id);
    const confirmed = await request(runtime.app).post(`/api/ai-write-approvals/${approvalId}/confirm`).send({}).expect(200);
    expect(confirmed.body.data.canRollback).toBe(true);
    expect((await request(runtime.app).get(`/api/settings/${setting.body.data.id}`).expect(200)).body.data.content).toBe("冷却十二小时。");
    await request(runtime.app).post(`/api/ai-write-approvals/${approvalId}/rollback`).send({}).expect(200);
    expect((await request(runtime.app).get(`/api/settings/${setting.body.data.id}`).expect(200)).body.data.content).toBe("冷却六小时。");
    const stale = await request(runtime.app).post(`/api/ai-write-approvals/${approvalId}/rollback`).send({}).expect(409);
    expect(stale.body.error.code).toBe("AI_WRITE_ROLLBACK_STALE");

    completionCount = 0;
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      completionCount += 1;
      if (completionCount === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              tool_calls: [{
                id: "create-setting",
                type: "function",
                function: {
                  name: "write_settings",
                  arguments: JSON.stringify({
                    summary: "新建一条冷却设定",
                    operations: [{
                      kind: "create_setting",
                      fields: { title: "额外冷却", category: "世界规则", content: "额外冷却不可撤销删除。" }
                    }]
                  })
                }
              }]
            }
          }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "请确认新建。" } }] }), { status: 200 });
    });
    const createStream = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "再新建一条冷却设定。",
      scope: { type: "none" },
      modelId,
      conversationId: conversation.body.data.id
    }).expect(200);
    const createApprovalId = String(parseSseEvents(createStream.text).find((item) => item.event === "write_approval")?.data.id);
    await request(runtime.app).post(`/api/ai-write-approvals/${createApprovalId}/confirm`).send({}).expect(200);
    const unsupported = await request(runtime.app).post(`/api/ai-write-approvals/${createApprovalId}/rollback`).send({}).expect(409);
    expect(unsupported.body.error.code).toBe("AI_WRITE_ROLLBACK_UNSUPPORTED");
    const after = await request(runtime.app).get(`/api/works/${workId}/settings`).expect(200);
    const created = (after.body.data.items ?? after.body.data).find((item: { title: string }) => item.title === "额外冷却");
    expect(created).toBeTruthy();
  });

  it("计划执行失败时不会留下部分写入", async () => {
    const modelId = await configureAi();
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentTools: ["write_characters"]
    }).expect(200);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      completionCount += 1;
      if (completionCount === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              tool_calls: [{
                id: "dup-characters",
                type: "function",
                function: {
                  name: "write_characters",
                  arguments: JSON.stringify({
                    summary: "重复创建同名角色",
                    operations: [
                      { kind: "create_character", fields: { name: "重复角色" } },
                      { kind: "create_character", fields: { name: "重复角色" } }
                    ]
                  })
                }
              }]
            }
          }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "请确认。" } }] }), { status: 200 });
    });
    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "创建两个同名角色。",
      scope: { type: "none" },
      modelId,
      conversationId: conversation.body.data.id
    }).expect(200);
    const approvalId = String(parseSseEvents(streamed.text).find((item) => item.event === "write_approval")?.data.id);
    const failed = await request(runtime.app).post(`/api/ai-write-approvals/${approvalId}/confirm`).send({}).expect(409);
    expect(failed.body.error.code).toBe("CHARACTER_NAME_CONFLICT");
    const approval = await request(runtime.app).get(`/api/ai-write-approvals/${approvalId}`).expect(200);
    expect(approval.body.data.status).toBe("failed");
    const characters = await request(runtime.app).get(`/api/works/${workId}/characters`).expect(200);
    const list = characters.body.data.items ?? characters.body.data;
    expect(Array.isArray(list) ? list.filter((item: { name: string }) => item.name === "重复角色") : []).toHaveLength(0);
  });
});

describe("AI 可写审批未登录保护", () => {
  it("未登录不能查看或确认审批", async () => {
    const { createRuntime } = await import("../../src/app.js");
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "test-master-secret-with-at-least-32-characters",
      serveUi: false
    });
    try {
      await request(runtime.app).get("/api/works/work_missing/ai-write-approvals").expect(401);
      await request(runtime.app).post("/api/ai-write-approvals/approval_missing/confirm").send({}).expect(401);
      await request(runtime.app).post("/api/ai-user-questions/question_missing/answer").send({ optionId: "keep" }).expect(401);
    } finally {
      runtime.close();
    }
  });
});
