import { createHash } from "node:crypto";
import { AppError } from "./errors.js";
import { normalizeCharacterName } from "./store.js";

export const CHARACTER_EXTRACTION_MAX_CANDIDATES = 500;
export const CHARACTER_EXTRACTION_MAX_NAME_LENGTH = 200;
export const CHARACTER_EXTRACTION_MAX_ALIASES = 100;
export const CHARACTER_EXTRACTION_MAX_IDENTITY_LENGTH = 20_000;
export const CHARACTER_EXTRACTION_MAX_SPECIES_LENGTH = 200;

export type CharacterExtractionEvidence = {
  chapterId: string;
  chapterTitle: string;
  quote: string;
};

export type CharacterExtractionCandidate = {
  candidateId: string;
  name: string;
  aliases: string[];
  species: string;
  identity: string;
  firstChapterId: string | null;
  firstEvidence: CharacterExtractionEvidence | null;
  stableCharacterId: string | null;
};

export type CharacterExtractionCandidateInput = Omit<CharacterExtractionCandidate, "candidateId"> & {
  candidateId?: string;
};

export type CharacterExtractionSelection = {
  candidateId: string;
  action: "create" | "merge" | "skip";
  targetCharacterId?: string;
  name?: string;
  aliases?: string[];
  species?: string;
  attributes?: { identity?: string };
};

export type EditableCharacterExtractionCandidate = {
  name: string;
  aliases: string[];
  species: string;
  identity: string;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeCharacterExtractionText(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/gu, " ") : "";
}

export function normalizeCharacterExtractionAliases(name: string, value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const primary = normalizeCharacterName(name);
  const aliases = new Map<string, string>();
  for (const item of value.slice(0, CHARACTER_EXTRACTION_MAX_ALIASES)) {
    const alias = normalizeCharacterExtractionText(item);
    if (!alias || alias.length > CHARACTER_EXTRACTION_MAX_NAME_LENGTH) continue;
    const normalized = normalizeCharacterName(alias);
    if (!normalized || normalized === primary || aliases.has(normalized)) continue;
    aliases.set(normalized, alias);
  }
  return [...aliases.values()];
}

export function normalizeCharacterExtractionCandidate(
  value: unknown,
  index: number
): CharacterExtractionCandidate | null {
  const candidate = recordValue(value);
  if (!candidate) return null;
  const name = normalizeCharacterExtractionText(candidate.name);
  if (!name || name.length > CHARACTER_EXTRACTION_MAX_NAME_LENGTH) return null;
  const identity = normalizeCharacterExtractionText(candidate.identity);
  const species = normalizeCharacterExtractionText(candidate.species);
  const evidence = recordValue(candidate.firstEvidence);
  const chapterId = normalizeCharacterExtractionText(evidence?.chapterId);
  const chapterTitle = normalizeCharacterExtractionText(evidence?.chapterTitle);
  const quote = normalizeCharacterExtractionText(evidence?.quote);
  const stableCharacterId = normalizeCharacterExtractionText(candidate.stableCharacterId);
  const candidateId = normalizeCharacterExtractionText(candidate.candidateId) || `candidate-${index + 1}`;
  if (candidateId.length > 100 || !/^[A-Za-z0-9_-]+$/u.test(candidateId)) return null;
  if (stableCharacterId.length > 200) return null;
  return {
    candidateId,
    name,
    aliases: normalizeCharacterExtractionAliases(name, candidate.aliases),
    species: species.length <= CHARACTER_EXTRACTION_MAX_SPECIES_LENGTH ? species : "",
    identity: identity.length <= CHARACTER_EXTRACTION_MAX_IDENTITY_LENGTH ? identity : "",
    firstChapterId: normalizeCharacterExtractionText(candidate.firstChapterId) || null,
    firstEvidence: chapterId && quote && quote.length <= 80
      ? { chapterId, chapterTitle: chapterTitle.slice(0, 300), quote }
      : null,
    stableCharacterId: stableCharacterId || null
  };
}

export function parseStoredCharacterExtractionCandidates(value: unknown): CharacterExtractionCandidate[] {
  if (!Array.isArray(value) || value.length > CHARACTER_EXTRACTION_MAX_CANDIDATES) {
    throw new AppError(409, "CHARACTER_EXTRACTION_PREVIEW_INVALID", "角色抽取预览数据无效，请重新运行任务");
  }
  const candidates = value.map((item, index) => normalizeCharacterExtractionCandidate(item, index));
  if (candidates.some((candidate) => candidate === null)) {
    throw new AppError(409, "CHARACTER_EXTRACTION_PREVIEW_INVALID", "角色抽取预览包含无效字段，请重新运行任务");
  }
  const parsed = candidates as CharacterExtractionCandidate[];
  if (new Set(parsed.map((candidate) => candidate.candidateId)).size !== parsed.length) {
    throw new AppError(409, "CHARACTER_EXTRACTION_PREVIEW_INVALID", "角色抽取预览候选标识重复，请重新运行任务");
  }
  return parsed;
}

export function editableCharacterExtractionCandidate(
  candidate: CharacterExtractionCandidate,
  selection: CharacterExtractionSelection
): EditableCharacterExtractionCandidate {
  const name = selection.name === undefined
    ? candidate.name
    : normalizeCharacterExtractionText(selection.name);
  if (!name || name.length > CHARACTER_EXTRACTION_MAX_NAME_LENGTH) {
    throw new AppError(400, "CHARACTER_EXTRACTION_NAME_INVALID", "角色标准名不能为空且不能超过 200 个字符", {
      candidateId: candidate.candidateId
    });
  }
  const aliases = selection.aliases === undefined
    ? candidate.aliases
    : normalizeCharacterExtractionAliases(name, selection.aliases);
  const rawAliases = selection.aliases ?? candidate.aliases;
  const normalizedAliases = rawAliases.map((alias) => normalizeCharacterName(normalizeCharacterExtractionText(alias)));
  if (rawAliases.length > CHARACTER_EXTRACTION_MAX_ALIASES
    || aliases.length !== rawAliases.length
    || normalizedAliases.some((alias) => !alias || alias === normalizeCharacterName(name))
    || new Set(normalizedAliases).size !== normalizedAliases.length) {
    throw new AppError(400, "CHARACTER_EXTRACTION_ALIASES_INVALID", "角色别名不能为空、重复、等同标准名或超过长度限制", {
      candidateId: candidate.candidateId
    });
  }
  const species = selection.species === undefined
    ? candidate.species
    : normalizeCharacterExtractionText(selection.species);
  const identity = selection.attributes?.identity === undefined
    ? candidate.identity
    : normalizeCharacterExtractionText(selection.attributes.identity);
  if (species.length > CHARACTER_EXTRACTION_MAX_SPECIES_LENGTH || identity.length > CHARACTER_EXTRACTION_MAX_IDENTITY_LENGTH) {
    throw new AppError(400, "CHARACTER_EXTRACTION_ATTRIBUTES_INVALID", "角色种族或身份字段超过长度限制", {
      candidateId: candidate.candidateId
    });
  }
  return { name, aliases, species, identity };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  const record = recordValue(value);
  if (!record) return value;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalValue(record[key])]));
}

export function characterExtractionHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

export function characterExtractionSelectionFingerprint(selections: CharacterExtractionSelection[]): string {
  return characterExtractionHash([...selections]
    .map((selection) => ({
      ...selection,
      aliases: selection.aliases ? [...selection.aliases] : undefined
    }))
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId)));
}
