// S3 备份配置相关的纯逻辑（无 DOM 依赖，便于单元测试）。

export function defaultBackupConfig() {
  return {
    targets: [],
    backupImages: true,
    scheduleTime: "03:00",
    retentionCount: 10
  };
}

export function createEmptyTarget() {
  const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `t-${Date.now()}`;
  return {
    id,
    name: "",
    endpoint: "",
    region: "us-east-1",
    bucket: "",
    subdir: "",
    enabled: true,
    accessKeyId: "",
    secretAccessKey: "",
    hasAccessKeyId: false,
    hasSecretAccessKey: false
  };
}

// 将备份实时状态归纳为前端可展示的状态标签。
export function describeBackupStatus(status) {
  if (!status) return { state: "idle", detail: "" };
  if (status.running) return { state: "running", detail: "备份任务正在执行" };
  if (status.lastError) return { state: "failed", detail: status.lastError };
  if (status.lastFinishedAt) return { state: "success", detail: "" };
  return { state: "idle", detail: "" };
}
