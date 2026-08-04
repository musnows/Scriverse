const byteUnits = ["B", "KB", "MB", "GB", "TB"];

const runStatusLabels = Object.freeze({
  running: "正在执行",
  success: "全部成功",
  partial: "部分失败",
  failed: "全部失败"
});

const targetStatusLabels = Object.freeze({
  enabled: "已启用",
  disabled: "已停用"
});

const connectionStatusLabels = Object.freeze({
  unchecked: "未测试",
  success: "连接正常",
  failed: "连接失败"
});

export function formatBackupBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < byteUnits.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(size) : size.toFixed(size >= 100 ? 0 : 1)} ${byteUnits[unit]}`;
}

export function backupRunStatusLabel(status) {
  return runStatusLabels[String(status)] ?? "未知状态";
}

export function backupTargetStatusLabel(status) {
  return targetStatusLabels[String(status)] ?? "未知状态";
}

export function backupConnectionStatusLabel(status) {
  return connectionStatusLabels[String(status)] ?? "未测试";
}

export function backupTriggerLabel(trigger) {
  return String(trigger) === "schedule" ? "定时任务" : "手动执行";
}

/** 目标卡片上的对象路径说明，覆盖未配置子目录的情况。 */
export function backupTargetPathSummary(target) {
  const root = String(target?.objectRoot ?? "scriverse");
  return `数据库：${root}/db/ · 图片：${root}/img/`;
}

/** 单个目标的同步结果摘要，用于备份记录列表。 */
export function backupTargetResultSummary(result) {
  const parts = [result?.databaseUploaded ? "数据库已上传" : "数据库未上传"];
  const uploaded = Number(result?.uploadedImageCount ?? 0);
  const skipped = Number(result?.skippedImageCount ?? 0);
  const failed = Number(result?.failedImageCount ?? 0);
  if (uploaded || skipped || failed) {
    parts.push(`图片新增 ${uploaded} 张、跳过 ${skipped} 张${failed ? `、失败 ${failed} 张` : ""}`);
  }
  const deleted = Number(result?.deletedBackupCount ?? 0);
  if (deleted) parts.push(`清理旧备份 ${deleted} 个`);
  return parts.join(" · ");
}

/** 失败原因的可读文案，优先展示 S3 服务端返回的错误码与描述。 */
export function backupFailureSummary(error) {
  if (!error) return "";
  const status = Number(error.httpStatus);
  const parts = [];
  if (Number.isFinite(status) && status > 0) parts.push(`HTTP ${status}`);
  if (error.s3Code) parts.push(String(error.s3Code));
  const message = String(error.s3Message || error.message || "").trim();
  if (message) parts.push(message);
  return parts.join(" · ") || "未知错误";
}

/** 定时备份失败后的前端提示文案，保证失败不会静默。 */
export function backupAlertMessage(run) {
  const failed = Array.isArray(run?.results) ? run.results.filter((item) => item?.status === "failed") : [];
  const first = failed[0];
  const scope = String(run?.status) === "partial"
    ? `${failed.length} 个备份目标失败`
    : "全部备份目标失败";
  const trigger = backupTriggerLabel(run?.trigger);
  const detail = first ? `${first.targetName}：${backupFailureSummary(first.error)}` : "请查看服务日志";
  return `${trigger}备份${scope}（${detail}）`;
}
