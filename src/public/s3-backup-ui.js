export function s3BackupRootPrefix(basePath = "") {
  const normalized = String(basePath).trim().replace(/^\/+|\/+$/gu, "").replace(/\/{2,}/gu, "/");
  return normalized ? `${normalized}/scriverse` : "scriverse";
}

export function s3BackupStatusLabel(status) {
  if (status === "succeeded") return "成功";
  if (status === "failed") return "失败";
  return "执行中";
}

export function collectS3BackupRunTransitions(previousSnapshots, runs, initialized, maximumSnapshots = 500) {
  const snapshots = new Map(previousSnapshots);
  const failures = [];
  for (const run of runs) {
    const previousStatus = snapshots.get(run.id);
    if (initialized && run.status === "failed" && previousStatus !== "failed") failures.push(run);
    snapshots.delete(run.id);
    snapshots.set(run.id, run.status);
  }
  while (snapshots.size > maximumSnapshots) snapshots.delete(snapshots.keys().next().value);
  return { snapshots, failures };
}

export function s3BackupFailureToast(run) {
  const reason = String(run?.errorMessage || "S3 服务请求失败").trim();
  return `S3 备份目标“${run?.targetName || "未命名目标"}”失败：${reason}`;
}
