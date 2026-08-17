import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime, seedChapter } from "../helpers.js";

describe("AI 时间计算工具", () => {
  let runtime: Runtime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    vi.restoreAllMocks();
  });

  function buildToolCall(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
    return {
      id: `test-${toolName}`,
      type: "function",
      function: {
        name: toolName,
        arguments: JSON.stringify(args)
      }
    };
  }

  it("diff 模式：计算两个日期之间的天数差", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "测试章节。");
    const workId = String(seeded.work.id);

    const internalAi = runtime.ai as unknown as {
      executeAgentTool: (
        candidateWorkId: string,
        toolCall: Record<string, unknown>,
        maximumResultChars?: number,
        roleplayCharacterId?: string | null,
        allowedToolIds?: ReadonlySet<string>
      ) => Promise<Record<string, unknown>>;
    };

    const execution = await internalAi.executeAgentTool(workId, buildToolCall("calculate_time", {
      operation: "diff",
      startYear: 2024,
      startMonth: 1,
      startDay: 1,
      endYear: 2024,
      endMonth: 12,
      endDay: 31
    }));

    expect(execution.status).toBe("completed");
    const result = execution.result as Record<string, unknown>;
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.operation).toBe("diff");
    expect(data.totalDays).toBe(365); // 2024 is leap year
    expect(data.absoluteDays).toBe(365);
    expect(data.direction).toBe("forward");
  });

  it("diff 模式：处理反向日期（结束日期早于开始日期）", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "测试章节。");
    const workId = String(seeded.work.id);

    const internalAi = runtime.ai as unknown as {
      executeAgentTool: (
        candidateWorkId: string,
        toolCall: Record<string, unknown>,
        maximumResultChars?: number,
        roleplayCharacterId?: string | null,
        allowedToolIds?: ReadonlySet<string>
      ) => Promise<Record<string, unknown>>;
    };

    const execution = await internalAi.executeAgentTool(workId, buildToolCall("calculate_time", {
      operation: "diff",
      startYear: 2131,
      startMonth: 4,
      startDay: 5,
      endYear: 2111,
      endMonth: 1,
      endDay: 2
    }));

    expect(execution.status).toBe("completed");
    const result = execution.result as Record<string, unknown>;
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.direction).toBe("backward");
    expect(data.absoluteDays).toBeGreaterThan(0);
  });

  it("diff 模式：处理闰年（2月有29天）", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "测试章节。");
    const workId = String(seeded.work.id);

    const internalAi = runtime.ai as unknown as {
      executeAgentTool: (
        candidateWorkId: string,
        toolCall: Record<string, unknown>,
        maximumResultChars?: number,
        roleplayCharacterId?: string | null,
        allowedToolIds?: ReadonlySet<string>
      ) => Promise<Record<string, unknown>>;
    };

    const execution = await internalAi.executeAgentTool(workId, buildToolCall("calculate_time", {
      operation: "diff",
      startYear: 2024,
      startMonth: 1,
      startDay: 1,
      endYear: 2024,
      endMonth: 3,
      endDay: 1
    }));

    expect(execution.status).toBe("completed");
    const result = execution.result as Record<string, unknown>;
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    // 2024 is leap year: Jan(31) + Feb(29) = 60 days
    expect(data.totalDays).toBe(60);
  });

  it("diff 模式：同一天差值为零", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "测试章节。");
    const workId = String(seeded.work.id);

    const internalAi = runtime.ai as unknown as {
      executeAgentTool: (
        candidateWorkId: string,
        toolCall: Record<string, unknown>,
        maximumResultChars?: number,
        roleplayCharacterId?: string | null,
        allowedToolIds?: ReadonlySet<string>
      ) => Promise<Record<string, unknown>>;
    };

    const execution = await internalAi.executeAgentTool(workId, buildToolCall("calculate_time", {
      operation: "diff",
      startYear: 2025,
      startMonth: 6,
      startDay: 15,
      endYear: 2025,
      endMonth: 6,
      endDay: 15
    }));

    expect(execution.status).toBe("completed");
    const result = execution.result as Record<string, unknown>;
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.totalDays).toBe(0);
  });

  it("add 模式：从起始日期推算未来日期", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "测试章节。");
    const workId = String(seeded.work.id);

    const internalAi = runtime.ai as unknown as {
      executeAgentTool: (
        candidateWorkId: string,
        toolCall: Record<string, unknown>,
        maximumResultChars?: number,
        roleplayCharacterId?: string | null,
        allowedToolIds?: ReadonlySet<string>
      ) => Promise<Record<string, unknown>>;
    };

    const execution = await internalAi.executeAgentTool(workId, buildToolCall("calculate_time", {
      operation: "add",
      startYear: 2024,
      startMonth: 1,
      startDay: 15,
      addYears: 2,
      addMonths: 3,
      addDays: 10
    }));

    expect(execution.status).toBe("completed");
    const result = execution.result as Record<string, unknown>;
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.operation).toBe("add");
    // 2024-01-15 + 2年 = 2026-01-15, +3月 = 2026-04-15, +10天 = 2026-04-25
    expect(data.resultDate).toBe("2026年4月25日");
  });

  it("add 模式：处理月末边界（1月31日 + 1个月 = 2月28/29日）", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "测试章节。");
    const workId = String(seeded.work.id);

    const internalAi = runtime.ai as unknown as {
      executeAgentTool: (
        candidateWorkId: string,
        toolCall: Record<string, unknown>,
        maximumResultChars?: number,
        roleplayCharacterId?: string | null,
        allowedToolIds?: ReadonlySet<string>
      ) => Promise<Record<string, unknown>>;
    };

    // 平年：2025-01-31 + 1个月 = 2025-02-28
    const execution1 = await internalAi.executeAgentTool(workId, buildToolCall("calculate_time", {
      operation: "add",
      startYear: 2025,
      startMonth: 1,
      startDay: 31,
      addMonths: 1
    }));

    expect(execution1.status).toBe("completed");
    const result1 = execution1.result as Record<string, unknown>;
    expect(result1.ok).toBe(true);
    const data1 = result1.data as Record<string, unknown>;
    expect(data1.resultDate).toBe("2025年2月28日");

    // 闰年：2024-01-31 + 1个月 = 2024-02-29
    const execution2 = await internalAi.executeAgentTool(workId, buildToolCall("calculate_time", {
      operation: "add",
      startYear: 2024,
      startMonth: 1,
      startDay: 31,
      addMonths: 1
    }));

    expect(execution2.status).toBe("completed");
    const result2 = execution2.result as Record<string, unknown>;
    expect(result2.ok).toBe(true);
    const data2 = result2.data as Record<string, unknown>;
    expect(data2.resultDate).toBe("2024年2月29日");
  });

  it("add 模式：正确处理负数月份的借位", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "测试章节。");
    const workId = String(seeded.work.id);

    const internalAi = runtime.ai as unknown as {
      executeAgentTool: (
        candidateWorkId: string,
        toolCall: Record<string, unknown>,
        maximumResultChars?: number,
        roleplayCharacterId?: string | null,
        allowedToolIds?: ReadonlySet<string>
      ) => Promise<Record<string, unknown>>;
    };

    const execution1 = await internalAi.executeAgentTool(workId, buildToolCall("calculate_time", {
      operation: "add",
      startYear: 2025,
      startMonth: 1,
      startDay: 15,
      addMonths: -1
    }));
    const result1 = execution1.result as Record<string, unknown>;
    const data1 = result1.data as Record<string, unknown>;
    expect(execution1.status).toBe("completed");
    expect(data1.resultDate).toBe("2024年12月15日");

    const execution2 = await internalAi.executeAgentTool(workId, buildToolCall("calculate_time", {
      operation: "add",
      startYear: 2025,
      startMonth: 1,
      startDay: 15,
      addMonths: -13
    }));
    const result2 = execution2.result as Record<string, unknown>;
    const data2 = result2.data as Record<string, unknown>;
    expect(execution2.status).toBe("completed");
    expect(data2.resultDate).toBe("2023年12月15日");
  });

  it("add 模式：日期增减应正确跨越月份和年份", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "测试章节。");
    const workId = String(seeded.work.id);

    const internalAi = runtime.ai as unknown as {
      executeAgentTool: (
        candidateWorkId: string,
        toolCall: Record<string, unknown>,
        maximumResultChars?: number,
        roleplayCharacterId?: string | null,
        allowedToolIds?: ReadonlySet<string>
      ) => Promise<Record<string, unknown>>;
    };

    const execution1 = await internalAi.executeAgentTool(workId, buildToolCall("calculate_time", {
      operation: "add",
      startYear: 2025,
      startMonth: 1,
      startDay: 31,
      addDays: 1
    }));
    const result1 = execution1.result as Record<string, unknown>;
    const data1 = result1.data as Record<string, unknown>;
    expect(execution1.status).toBe("completed");
    expect(data1.resultDate).toBe("2025年2月1日");

    const execution2 = await internalAi.executeAgentTool(workId, buildToolCall("calculate_time", {
      operation: "add",
      startYear: 2025,
      startMonth: 1,
      startDay: 5,
      addDays: -10
    }));
    const result2 = execution2.result as Record<string, unknown>;
    const data2 = result2.data as Record<string, unknown>;
    expect(execution2.status).toBe("completed");
    expect(data2.resultDate).toBe("2024年12月26日");
  });

  it("diff 模式：处理未来日期（2111年与2131年）", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "测试章节。");
    const workId = String(seeded.work.id);

    const internalAi = runtime.ai as unknown as {
      executeAgentTool: (
        candidateWorkId: string,
        toolCall: Record<string, unknown>,
        maximumResultChars?: number,
        roleplayCharacterId?: string | null,
        allowedToolIds?: ReadonlySet<string>
      ) => Promise<Record<string, unknown>>;
    };

    const execution = await internalAi.executeAgentTool(workId, buildToolCall("calculate_time", {
      operation: "diff",
      startYear: 2111,
      startMonth: 1,
      startDay: 2,
      endYear: 2131,
      endMonth: 4,
      endDay: 5
    }));

    expect(execution.status).toBe("completed");
    const result = execution.result as Record<string, unknown>;
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.totalDays).toBeGreaterThan(0);
  });

  it("无效日期应返回失败：月份超出范围", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "测试章节。");
    const workId = String(seeded.work.id);

    const internalAi = runtime.ai as unknown as {
      executeAgentTool: (
        candidateWorkId: string,
        toolCall: Record<string, unknown>,
        maximumResultChars?: number,
        roleplayCharacterId?: string | null,
        allowedToolIds?: ReadonlySet<string>
      ) => Promise<Record<string, unknown>>;
    };

    const execution = await internalAi.executeAgentTool(workId, buildToolCall("calculate_time", {
      operation: "diff",
      startYear: 2024,
      startMonth: 13,
      startDay: 1,
      endYear: 2024,
      endMonth: 1,
      endDay: 1
    }));

    expect(execution.status).toBe("failed");
    const result = execution.result as Record<string, unknown>;
    expect(result.ok).toBe(false);
  });

  it("无效日期应返回失败：2月30日", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "测试章节。");
    const workId = String(seeded.work.id);

    const internalAi = runtime.ai as unknown as {
      executeAgentTool: (
        candidateWorkId: string,
        toolCall: Record<string, unknown>,
        maximumResultChars?: number,
        roleplayCharacterId?: string | null,
        allowedToolIds?: ReadonlySet<string>
      ) => Promise<Record<string, unknown>>;
    };

    const execution = await internalAi.executeAgentTool(workId, buildToolCall("calculate_time", {
      operation: "diff",
      startYear: 2024,
      startMonth: 2,
      startDay: 30,
      endYear: 2024,
      endMonth: 1,
      endDay: 1
    }));

    expect(execution.status).toBe("failed");
    const result = execution.result as Record<string, unknown>;
    expect(result.ok).toBe(false);
  });

  it("缺少必要参数应返回失败", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "测试章节。");
    const workId = String(seeded.work.id);

    const internalAi = runtime.ai as unknown as {
      executeAgentTool: (
        candidateWorkId: string,
        toolCall: Record<string, unknown>,
        maximumResultChars?: number,
        roleplayCharacterId?: string | null,
        allowedToolIds?: ReadonlySet<string>
      ) => Promise<Record<string, unknown>>;
    };

    const execution = await internalAi.executeAgentTool(workId, buildToolCall("calculate_time", {
      operation: "diff",
      startYear: 2024,
      startMonth: 1
    }));

    expect(execution.status).toBe("failed");
  });
});
