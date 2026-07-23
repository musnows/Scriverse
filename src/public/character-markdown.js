const supportedImageMimeType = /^image\/(?:png|jpe?g|webp|gif)$/u;

export function clipboardImageFiles(clipboardData) {
  const items = Array.from(clipboardData?.items ?? []);
  const itemFiles = items
    .filter((item) => item.kind === "file" && supportedImageMimeType.test(String(item.type ?? "")))
    .map((item) => item.getAsFile?.())
    .filter(Boolean);
  if (itemFiles.length > 0) return itemFiles;
  return Array.from(clipboardData?.files ?? [])
    .filter((file) => supportedImageMimeType.test(String(file.type ?? "")));
}
