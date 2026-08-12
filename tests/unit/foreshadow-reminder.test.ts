import { describe, expect, it } from "vitest";
import {
  foreshadowReminderRequestTargetsState,
  foreshadowReminderSnoozeKey,
  normalizeForeshadowReminders,
  parseForeshadowReminderSnoozes,
  serializeForeshadowReminderSnoozes,
  visibleForeshadowReminders
} from "../../src/public/foreshadow-reminder.js";

const reminder = {
  foreshadowId: "foreshadow-a",
  occurrenceId: "occurrence-a",
  title: "旧信",
  description: "旧信背面有火漆。",
  status: "planted",
  importance: "high",
  role: "reminder",
  note: "再次看见火漆",
  versionNo: 2,
  updatedAt: "2026-08-12T00:00:00.000Z"
} as const;

describe("编辑器伏笔提醒状态", () => {
  it("只保留字段完整的提醒与回收节点", () => {
    expect(normalizeForeshadowReminders([
      reminder,
      { ...reminder, foreshadowId: "foreshadow-b", occurrenceId: "occurrence-b", role: "payoff" },
      { ...reminder, foreshadowId: "", occurrenceId: "occurrence-invalid" },
      { ...reminder, occurrenceId: "occurrence-setup", role: "setup" },
      { ...reminder, occurrenceId: "occurrence-version", versionNo: 0 },
      null
    ])).toEqual([
      reminder,
      { ...reminder, foreshadowId: "foreshadow-b", occurrenceId: "occurrence-b", role: "payoff" }
    ]);
  });

  it("用作品、章节、出现点和版本生成不含内容的会话静默键", () => {
    const key = foreshadowReminderSnoozeKey("work-a", "chapter-a", reminder);
    expect(key).toContain("work-a");
    expect(key).toContain("chapter-a");
    expect(key).toContain("occurrence-a");
    expect(key).toContain("v2");
    expect(key).not.toContain("旧信");
    expect(foreshadowReminderSnoozeKey("work-a", "chapter-a", { ...reminder, versionNo: 3 })).not.toBe(key);
    expect(foreshadowReminderSnoozeKey("work-a", "chapter-b", reminder)).not.toBe(key);
  });

  it("容错读取并限制会话静默记录数量", () => {
    expect([...parseForeshadowReminderSnoozes("not-json")]).toEqual([]);
    expect([...parseForeshadowReminderSnoozes(JSON.stringify(["a", "a", 1, "b"]))]).toEqual(["a", "b"]);
    expect(serializeForeshadowReminderSnoozes(new Set(["a", "b", "c"]), 2)).toBe('["b","c"]');
  });

  it("同一版本暂不处理后不再展示，新版本会重新提醒", () => {
    const key = foreshadowReminderSnoozeKey("work-a", "chapter-a", reminder);
    if (!key) throw new Error("提醒静默键生成失败");
    const snoozes = new Set([key]);
    expect(visibleForeshadowReminders([reminder], "work-a", "chapter-a", snoozes)).toEqual([]);
    expect(visibleForeshadowReminders([{ ...reminder, versionNo: 3 }], "work-a", "chapter-a", snoozes)).toHaveLength(1);
    expect(visibleForeshadowReminders([reminder], "work-a", "chapter-b", snoozes)).toHaveLength(1);
  });

  it("旧章节请求不能命中新作品或新章节状态", () => {
    const request = { workId: "work-a", chapterId: "chapter-a" };
    expect(foreshadowReminderRequestTargetsState(request, { workId: "work-a", chapterId: "chapter-a" })).toBe(true);
    expect(foreshadowReminderRequestTargetsState(request, { workId: "work-a", chapterId: "chapter-b" })).toBe(false);
    expect(foreshadowReminderRequestTargetsState(request, { workId: "work-b", chapterId: "chapter-a" })).toBe(false);
  });
});
