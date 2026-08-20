function sanitizeFileNamePart(value: string, fallback: string): string {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/[<>:"/\\|?*]/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/^[.\s-]+|[.\s-]+$/gu, "");
  return Array.from(normalized || fallback).slice(0, 120).join("");
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/gu, (character) => (
    `%${character.codePointAt(0)!.toString(16).toUpperCase()}`
  ));
}

export function attachmentDownloadFileName(contextName: string | null, originalName: string): string {
  const context = sanitizeFileNamePart(contextName ?? "", "项目图片");
  const original = sanitizeFileNamePart(originalName, "图片");
  return `scriverse-${context}-${original}`;
}

export function inlineContentDisposition(fileName: string): string {
  const fallback = fileName
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/gu, "_")
    .replace(/["\\;]/gu, "_")
    .slice(0, 180) || "image";
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}
