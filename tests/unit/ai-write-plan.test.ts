import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors.js";
import {
  recommendedAskUserOptionLabel,
  resolveAiWritePlanMaxOperations,
  intersectWorkModulePermissions,
  redactSensitiveApprovalText
} from "../../src/ai-write-plan.js";
import { emptyWorkModulePermissions, fullWorkModulePermissions } from "../../src/work-permissions.js";
import { normalizeWorkAgentTools, WORK_AGENT_TOOL_IDS } from "../../src/store.js";
import { WORK_AGENT_READ_TOOL_IDS, WORK_AGENT_WRITE_TOOL_IDS } from "../../src/ai-write-plan.js";

describe("AI 可写计划规则", () => {
  it("默认最多 5 项操作，有效范围是 1 到 20", () => {
    expect(resolveAiWritePlanMaxOperations(undefined)).toBe(5);
    expect(resolveAiWritePlanMaxOperations("")).toBe(5);
    expect(resolveAiWritePlanMaxOperations("8")).toBe(8);
    expect(resolveAiWritePlanMaxOperations("1")).toBe(1);
    expect(resolveAiWritePlanMaxOperations("20")).toBe(20);
    expect(() => resolveAiWritePlanMaxOperations("0")).toThrow(AppError);
    expect(() => resolveAiWritePlanMaxOperations("21")).toThrow(AppError);
    expect(() => resolveAiWritePlanMaxOperations("abc")).toThrow(AppError);
    try {
      resolveAiWritePlanMaxOperations("21");
    } catch (error) {
      expect(error).toMatchObject({ code: "AI_WRITE_PLAN_MAX_OPERATIONS_INVALID" });
    }
  });

  it("第一个提问选项会标注最推荐", () => {
    expect(recommendedAskUserOptionLabel("沿用现有设定", 0)).toBe("沿用现有设定（最推荐）");
    expect(recommendedAskUserOptionLabel("沿用现有设定（最推荐）", 0)).toBe("沿用现有设定（最推荐）");
    expect(recommendedAskUserOptionLabel("新建词条", 1)).toBe("新建词条");
  });

  it("写权限取当前用户与对话归属用户的交集", () => {
    const current = { ...fullWorkModulePermissions(), settings: "write" as const, characters: "read" as const, prose: "none" as const };
    const owner = { ...fullWorkModulePermissions(), settings: "read" as const, characters: "write" as const, prose: "write" as const };
    expect(intersectWorkModulePermissions(current, owner)).toMatchObject({
      settings: "read",
      characters: "read",
      prose: "none"
    });
    expect(intersectWorkModulePermissions(null, owner)).toEqual(emptyWorkModulePermissions());
  });

  it("默认可写工具全部关闭，只保留只读查询工具", () => {
    expect(normalizeWorkAgentTools(undefined)).toEqual([...WORK_AGENT_READ_TOOL_IDS]);
    expect(normalizeWorkAgentTools([])).toEqual([]);
    expect(normalizeWorkAgentTools(["write_settings", "story_index"])).toEqual(["story_index", "write_settings"]);
    expect(WORK_AGENT_TOOL_IDS).toEqual([...WORK_AGENT_READ_TOOL_IDS, ...WORK_AGENT_WRITE_TOOL_IDS]);
    expect(normalizeWorkAgentTools(undefined).some((toolId) => toolId.startsWith("write_") || toolId === "ask_user_questions")).toBe(false);
  });

  it("审批文本会去掉密钥和令牌", () => {
    expect(redactSensitiveApprovalText("api_key=sk-abcdefghijklmnopqrstuvwxyz")).toContain("[REDACTED]");
    expect(redactSensitiveApprovalText("token: secret-value-123456")).toContain("[REDACTED]");
  });
});
