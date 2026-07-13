import { AppError } from "./errors.js";

export type ImportContentThreat = {
  code: "ACTIVE_HTML_TAG" | "EVENT_HANDLER" | "SCRIPT_URI" | "EMBEDDED_DOCUMENT" | "ACTIVE_CSS";
};

function decodeEntitiesForInspection(value: string): string {
  const decodeCodePoint = (digits: string, radix: number): string => {
    const codePoint = Number.parseInt(digits, radix);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
  };
  return value
    .replace(/&#x([0-9a-f]+);?/giu, (_match, digits) => decodeCodePoint(String(digits), 16))
    .replace(/&#([0-9]+);?/gu, (_match, digits) => decodeCodePoint(String(digits), 10))
    .replace(/&colon;/giu, ":")
    .replace(/&(tab|newline);/giu, " ");
}

export function inspectImportedPlainText(value: string): ImportContentThreat[] {
  const normalized = decodeEntitiesForInspection(String(value ?? "").normalize("NFKC").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, ""));
  const compact = normalized.replace(/\s+/gu, "");
  const threats: ImportContentThreat[] = [];
  if (/<\s*\/?\s*(script|iframe|object|embed|applet|meta|link|base|svg|math)\b/iu.test(normalized)) threats.push({ code: "ACTIVE_HTML_TAG" });
  if (/<[^>]{0,4000}\bon[a-z][\w:-]*\s*=/iu.test(normalized)) threats.push({ code: "EVENT_HANDLER" });
  if (/<[^>]{0,4000}(javascript|vbscript):/iu.test(compact)) threats.push({ code: "SCRIPT_URI" });
  if (/<[^>]{0,4000}\bsrcdoc\s*=/iu.test(normalized) || /<[^>]{0,4000}data:text\/html/iu.test(compact)) threats.push({ code: "EMBEDDED_DOCUMENT" });
  if (/<[^>]{0,4000}\bstyle\s*=[^>]{0,4000}(expression\s*\(|url\s*\(\s*(javascript|vbscript):)/iu.test(normalized)) threats.push({ code: "ACTIVE_CSS" });
  return threats;
}

export function assertSafeImportedPlainText(value: string): void {
  const threats = inspectImportedPlainText(value);
  if (threats.length) {
    throw new AppError(422, "UNSAFE_IMPORT_CONTENT", "导入文件包含可能执行脚本的 HTML 内容，已拒绝导入", {
      threats: threats.map((threat) => threat.code)
    });
  }
}
