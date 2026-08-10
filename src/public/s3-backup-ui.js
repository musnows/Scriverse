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

export function s3BackupEncryptionPresentation(state) {
  if (state?.enabled) {
    return {
      label: "已开启",
      statusClass: "is-enabled",
      description: "新生成的数据库快照、恢复密钥和图片会以 AES-256-GCM 信封密文上传。",
      showPrivateBucketWarning: false
    };
  }
  if (state?.keyConfiguredAt) {
    return {
      label: "已关闭",
      statusClass: "",
      description: "新备份恢复为明文上传；原密钥仍保留，以便解密历史备份。",
      showPrivateBucketWarning: true
    };
  }
  return {
    label: "未开启",
    statusClass: "",
    description: "备份将以明文上传，请确保所有 S3 目标桶均为私有桶。",
    showPrivateBucketWarning: true
  };
}

export function s3BackupEncryptionKeyFile(key) {
  return `${String(key).trim()}\n`;
}
