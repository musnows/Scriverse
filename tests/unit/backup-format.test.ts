import { describe, expect, it } from "vitest";
import {
  backupAlertMessage,
  backupConnectionStatusLabel,
  backupFailureSummary,
  backupRunStatusLabel,
  backupTargetPathSummary,
  backupTargetResultSummary,
  backupTargetStatusLabel,
  backupTriggerLabel,
  formatBackupBytes
} from "../../src/public/backup-format.js";

describe("备份体积格式化", () => {
  it("按 1024 进制换算并保留合适精度", () => {
    expect(formatBackupBytes(0)).toBe("0 B");
    expect(formatBackupBytes(512)).toBe("512 B");
    expect(formatBackupBytes(1024)).toBe("1.0 KB");
    expect(formatBackupBytes(1536)).toBe("1.5 KB");
    expect(formatBackupBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBackupBytes(983_040)).toBe("960 KB");
    expect(formatBackupBytes(5 * 1024 ** 4)).toBe("5.0 TB");
  });

  it("非法输入按 0 处理", () => {
    expect(formatBackupBytes(-1)).toBe("0 B");
    expect(formatBackupBytes(Number.NaN)).toBe("0 B");
    expect(formatBackupBytes(undefined)).toBe("0 B");
  });
});

describe("备份状态文案", () => {
  it("覆盖运行、目标与连接状态", () => {
    expect(backupRunStatusLabel("success")).toBe("全部成功");
    expect(backupRunStatusLabel("partial")).toBe("部分失败");
    expect(backupRunStatusLabel("failed")).toBe("全部失败");
    expect(backupRunStatusLabel("running")).toBe("正在执行");
    expect(backupRunStatusLabel("unexpected")).toBe("未知状态");
    expect(backupTargetStatusLabel("enabled")).toBe("已启用");
    expect(backupTargetStatusLabel("disabled")).toBe("已停用");
    expect(backupConnectionStatusLabel("success")).toBe("连接正常");
    expect(backupConnectionStatusLabel("failed")).toBe("连接失败");
    expect(backupConnectionStatusLabel(undefined)).toBe("未测试");
    expect(backupTriggerLabel("schedule")).toBe("定时任务");
    expect(backupTriggerLabel("manual")).toBe("手动执行");
  });
});

describe("备份目标路径说明", () => {
  it("展示数据库与图片各自的对象目录", () => {
    expect(backupTargetPathSummary({ objectRoot: "team/alpha/scriverse" }))
      .toBe("数据库：team/alpha/scriverse/db/ · 图片：team/alpha/scriverse/img/");
    expect(backupTargetPathSummary({})).toBe("数据库：scriverse/db/ · 图片：scriverse/img/");
  });
});

describe("单目标同步结果摘要", () => {
  it("只备份数据库时不提图片", () => {
    expect(backupTargetResultSummary({ databaseUploaded: true, uploadedImageCount: 0, skippedImageCount: 0 }))
      .toBe("数据库已上传");
  });

  it("包含图片增量与旧备份清理数量", () => {
    expect(backupTargetResultSummary({
      databaseUploaded: true,
      uploadedImageCount: 3,
      skippedImageCount: 12,
      failedImageCount: 0,
      deletedBackupCount: 2
    })).toBe("数据库已上传 · 图片新增 3 张、跳过 12 张 · 清理旧备份 2 个");
  });

  it("图片失败时单独标注", () => {
    expect(backupTargetResultSummary({ databaseUploaded: false, uploadedImageCount: 1, skippedImageCount: 0, failedImageCount: 4 }))
      .toBe("数据库未上传 · 图片新增 1 张、跳过 0 张、失败 4 张");
  });
});

describe("失败原因摘要", () => {
  it("优先展示 S3 状态码、错误码与描述", () => {
    expect(backupFailureSummary({ httpStatus: 403, s3Code: "AccessDenied", s3Message: "拒绝访问" }))
      .toBe("HTTP 403 · AccessDenied · 拒绝访问");
  });

  it("网络错误没有 HTTP 状态时退回消息文本", () => {
    expect(backupFailureSummary({ httpStatus: null, s3Code: "NETWORK_ERROR", s3Message: "连接超时" }))
      .toBe("NETWORK_ERROR · 连接超时");
    expect(backupFailureSummary({ message: "S3 请求超时（30 秒）" })).toBe("S3 请求超时（30 秒）");
    expect(backupFailureSummary({})).toBe("未知错误");
    expect(backupFailureSummary(null)).toBe("");
  });
});

describe("备份失败提示文案", () => {
  it("全部失败时说明范围并带上首个目标的错误", () => {
    expect(backupAlertMessage({
      trigger: "schedule",
      status: "failed",
      results: [{ status: "failed", targetName: "主备份桶", error: { httpStatus: 500, s3Code: "InternalError", s3Message: "存储异常" } }]
    })).toBe("定时任务备份全部备份目标失败（主备份桶：HTTP 500 · InternalError · 存储异常）");
  });

  it("部分失败时给出失败目标数量", () => {
    expect(backupAlertMessage({
      trigger: "manual",
      status: "partial",
      results: [
        { status: "success", targetName: "主备份桶" },
        { status: "failed", targetName: "灾备桶", error: { httpStatus: 403, s3Code: "AccessDenied" } }
      ]
    })).toBe("手动执行备份1 个备份目标失败（灾备桶：HTTP 403 · AccessDenied）");
  });

  it("缺少目标明细时提示查看日志", () => {
    expect(backupAlertMessage({ trigger: "schedule", status: "failed", results: [] }))
      .toBe("定时任务备份全部备份目标失败（请查看服务日志）");
    expect(backupAlertMessage({})).toContain("请查看服务日志");
  });
});
