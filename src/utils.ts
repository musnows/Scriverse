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
