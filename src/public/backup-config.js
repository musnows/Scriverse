const backupRunStatusLabels = Object.freeze({
  queued: "排队中",
  running: "备份中",
  success: "成功",
  failed: "失败"
});

const backupRunTriggerLabels = Object.freeze({
  manual: "手动",
  schedule: "定时"
});

export function backupRunStatusLabel(status) {
  const normalized = String(status ?? "");
  return Object.hasOwn(backupRunStatusLabels, normalized) ? backupRunStatusLabels[normalized] : status;
}

export function backupRunTriggerLabel(trigger) {
  const normalized = String(trigger ?? "");
  return Object.hasOwn(backupRunTriggerLabels, normalized) ? backupRunTriggerLabels[normalized] : trigger;
}

export function backupConfigTargetSummary(config = {}) {
  const bucket = String(config?.bucket ?? "");
  const prefix = String(config?.pathPrefix ?? "").replace(/^\/+|\/+$/gu, "");
  const directory = prefix ? `${prefix}/scriverse/` : "scriverse/";
  const style = config?.forcePathStyle ? "路径风格" : "虚拟主机风格";
  return `${bucket} · ${directory} · ${style}`;
}

export function backupConfigScheduleSummary(config = {}) {
  const time = String(config?.scheduleTime ?? "");
  const retention = Number(config?.retentionCount ?? 0);
  return `每日 ${time} · 留存 ${retention} 份 · ${config?.includeImages ? "含图片" : "仅数据库"}`;
}

export function nextBackupAlertWatermark(runs, currentWatermark) {
  let watermark = typeof currentWatermark === "string" && currentWatermark ? currentWatermark : null;
  for (const run of Array.isArray(runs) ? runs : []) {
    const finishedAt = run && typeof run.finishedAt === "string" ? run.finishedAt : "";
    if (finishedAt && (watermark === null || finishedAt > watermark)) watermark = finishedAt;
  }
  if (watermark !== null) return watermark;
  return currentWatermark ?? null;
}

export function backupFailureToastMessage(run) {
  const configName = String(run?.configName ?? "") || "未知目标";
  const error = String(run?.error ?? "") || "未知错误";
  return `备份目标「${configName}」同步失败：${error}`;
}
