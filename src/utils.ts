import { randomUUID } from "node:crypto";

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function countWords(text: string): number {
  const compact = text.replace(/\s+/gu, "");
  const chinese = compact.match(/[\p{Script=Han}]/gu)?.length ?? 0;
  const withoutChinese = text.replace(/[\p{Script=Han}]/gu, " ");
  const latin = withoutChinese.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return chinese + latin;
}

export function normalizeParagraphSpacing(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\p{Zs}\uFEFF]+$/gmu, "")
    .replace(/^\n+/u, "")
    .replace(/\n+$/u, "")
    .replace(/\n{3,}/gu, "\n\n");
}

export function splitDocumentParagraphs(value: string): string[] {
  return value
    .split(/\n[\t\p{Zs}\uFEFF]*\n+/gu)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export function normalizeDocumentSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN");
}

export function documentShortSearchTerms(value: string): string[] {
  const characters = [...normalizeDocumentSearchText(value)];
  const terms = new Set(characters);
  for (let index = 0; index < characters.length - 1; index += 1) {
    terms.add(`${characters[index]}${characters[index + 1]}`);
  }
  return [...terms];
}

export function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/u, "").replace(/\/chat\/completions$/u, "");
}

export function normalizeUploadFileName(value: string): string {
  if ([...value].some((character) => character.codePointAt(0)! > 0xff)) return value;
  const decoded = Buffer.from(value, "latin1").toString("utf8");
  return decoded.includes("�") ? value : decoded;
}

export function maskSecret(secret: string): string {
  if (secret.length <= 8) return "********";
  return `${secret.slice(0, 3)}${"*".repeat(Math.min(12, secret.length - 7))}${secret.slice(-4)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
