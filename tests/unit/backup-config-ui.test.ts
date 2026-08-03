import { describe, expect, it } from "vitest";
import {
  backupConfigScheduleSummary,
  backupConfigTargetSummary,
  backupFailureToastMessage,
  backupRunStatusLabel,
  backupRunTriggerLabel,
  nextBackupAlertWatermark
} from "../../src/public/backup-config.js";

describe("数据备份界面纯逻辑", () => {
  it("翻译备份执行状态与触发方式，未知值原样返回", () => {
    expect(backupRunStatusLabel("queued")).toBe("排队中");
    expect(backupRunStatusLabel("running")).toBe("备份中");
    expect(backupRunStatusLabel("success")).toBe("成功");
    expect(backupRunStatusLabel("failed")).toBe("失败");
    expect(backupRunStatusLabel("paused")).toBe("paused");
    expect(backupRunTriggerLabel("manual")).toBe("手动");
    expect(backupRunTriggerLabel("schedule")).toBe("定时");
    expect(backupRunTriggerLabel("adhoc")).toBe("adhoc");
  });

  it("汇总备份目标的存储位置与路径风格", () => {
    expect(backupConfigTargetSummary({ bucket: "my-bucket", pathPrefix: "team/daily", forcePathStyle: true }))
      .toBe("my-bucket · team/daily/scriverse/ · 路径风格");
    expect(backupConfigTargetSummary({ bucket: "my-bucket", pathPrefix: "", forcePathStyle: false }))
      .toBe("my-bucket · scriverse/ · 虚拟主机风格");
    expect(backupConfigTargetSummary({ bucket: "my-bucket", pathPrefix: "/team/daily/", forcePathStyle: true }))
      .toBe("my-bucket · team/daily/scriverse/ · 路径风格");
  });

  it("汇总每日定时、留存份数与图片开关", () => {
    expect(backupConfigScheduleSummary({ scheduleTime: "03:00", retentionCount: 7, includeImages: true }))
      .toBe("每日 03:00 · 留存 7 份 · 含图片");
    expect(backupConfigScheduleSummary({ scheduleTime: "23:30", retentionCount: 30, includeImages: false }))
      .toBe("每日 23:30 · 留存 30 份 · 仅数据库");
  });

  it("按字典序推进失败告警水位线", () => {
    expect(nextBackupAlertWatermark([], null)).toBeNull();
    expect(nextBackupAlertWatermark([], undefined)).toBeNull();
    expect(nextBackupAlertWatermark([
      { finishedAt: "2026-08-03T01:00:00.000Z" },
      { finishedAt: null },
      { finishedAt: "2026-08-03T03:00:00.000Z" },
      {}
    ], null)).toBe("2026-08-03T03:00:00.000Z");
    expect(nextBackupAlertWatermark([{ finishedAt: "2026-08-03T01:00:00.000Z" }], "2026-08-03T02:00:00.000Z"))
      .toBe("2026-08-03T02:00:00.000Z");
    expect(nextBackupAlertWatermark([], "2026-08-03T02:00:00.000Z")).toBe("2026-08-03T02:00:00.000Z");
  });

  it("生成备份失败提示文案并兜底缺失字段", () => {
    expect(backupFailureToastMessage({ configName: "公司 MinIO", error: "网络超时" }))
      .toBe("备份目标「公司 MinIO」同步失败：网络超时");
    expect(backupFailureToastMessage({ configName: "", error: "" }))
      .toBe("备份目标「未知目标」同步失败：未知错误");
    expect(backupFailureToastMessage(null)).toBe("备份目标「未知目标」同步失败：未知错误");
  });
});
