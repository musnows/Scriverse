export function normalizeUploadProgress(value) {
  const candidate = Number(value);
  if (!Number.isFinite(candidate)) return null;
  return Math.max(0, Math.min(100, Math.round(candidate)));
}

export function uploadProgressText(value) {
  const progress = normalizeUploadProgress(value);
  return progress === null ? "正在上传" : `上传中 ${progress}%`;
}
