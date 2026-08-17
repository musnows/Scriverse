import { describe, expect, it } from "vitest";
import {
  backgroundTaskActivityCount,
  backgroundTaskPollDelay,
  collectBackgroundTaskTransitions,
  filterBackgroundTaskTransitionsForAnnouncement
} from "../../src/public/background-task-center.js";

describe("全局后台任务中心", () => {
  it("合并分析任务和索引队列的活动数量", () => {
    expect(backgroundTaskActivityCount(
      { stats: { pendingCount: 2, runningCount: 1 } },
      { status: "queued", queuedSourceCount: 18 }
    )).toBe(4);
    expect(backgroundTaskActivityCount(
      { stats: { pendingCount: 0, runningCount: 0 } },
      { status: "ready", queuedSourceCount: 0 }
    )).toBe(0);
  });

  it("首次加载不提醒历史任务，只提醒活动任务的后续终态", () => {
    const initial = collectBackgroundTaskTransitions(new Map(), [
      { id: "old", status: "review" },
      { id: "active", status: "running" }
    ], false);
    expect(initial.transitions).toEqual([]);

    const completed = collectBackgroundTaskTransitions(initial.snapshots, [
      { id: "old", status: "review" },
      { id: "active", status: "partial" }
    ], true);
    expect(completed.transitions).toEqual([
      expect.objectContaining({ previousStatus: "running", status: "partial" })
    ]);

    const unchanged = collectBackgroundTaskTransitions(completed.snapshots, [
      { id: "active", status: "partial" }
    ], true);
    expect(unchanged.transitions).toEqual([]);
  });

  it("把明确失败识别为终态变化", () => {
    const initial = collectBackgroundTaskTransitions(new Map([["failed-task", "running"]]), [
      { id: "failed-task", status: "failed" }
    ], true);
    expect(initial.transitions).toEqual([
      expect.objectContaining({ previousStatus: "running", status: "failed" })
    ]);
  });

  it("按分析类型降低连续过期提醒频率，但不影响其他终态提醒", () => {
    const transitions = [
      { task: { id: "chapter-1", taskType: "chapter-analysis" }, previousStatus: "running", status: "expired" },
      { task: { id: "chapter-2", taskType: "chapter-analysis" }, previousStatus: "running", status: "expired" },
      { task: { id: "book-1", taskType: "book-analysis" }, previousStatus: "running", status: "expired" },
      { task: { id: "failed-1", taskType: "chapter-analysis" }, previousStatus: "running", status: "failed" }
    ];
    const first = filterBackgroundTaskTransitionsForAnnouncement(transitions, new Map(), 1_000);
    expect(first.transitions).toHaveLength(3);
    expect(first.transitions.map((transition) => transition.task.id)).toEqual(["chapter-1", "book-1", "failed-1"]);

    const second = filterBackgroundTaskTransitionsForAnnouncement([
      { task: { id: "chapter-3", taskType: "chapter-analysis" }, previousStatus: "running", status: "expired" }
    ], first.noticeTimes, 30_000);
    expect(second.transitions).toEqual([]);

    const afterCooldown = filterBackgroundTaskTransitionsForAnnouncement([
      { task: { id: "chapter-4", taskType: "chapter-analysis" }, previousStatus: "running", status: "expired" }
    ], second.noticeTimes, 61_000);
    expect(afterCooldown.transitions).toHaveLength(1);
  });

  it("活动任务或打开弹窗时采用更短轮询间隔", () => {
    expect(backgroundTaskPollDelay(1, false)).toBe(5_000);
    expect(backgroundTaskPollDelay(0, true)).toBe(5_000);
    expect(backgroundTaskPollDelay(0, false)).toBe(15_000);
  });
});
