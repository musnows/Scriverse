import { canReadWorkModule, type WorkModulePermissions, type WorkPermissionModule } from "./work-permissions.js";

export const HYBRID_SEARCH_TYPES = [
  "chapter",
  "setting",
  "character",
  "race",
  "organization",
  "timeline-track",
  "timeline-event",
  "relationship",
  "chapter-outline",
  "foreshadow",
  "review",
  "agent-history"
] as const;

export const MAXIMUM_WORK_SEARCH_QUERY_LENGTH = 100;

export function normalizeWorkSearchQuery(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .trim()
    .slice(0, MAXIMUM_WORK_SEARCH_QUERY_LENGTH);
}

export type HybridSearchType = typeof HYBRID_SEARCH_TYPES[number];
export type HybridSearchMatchKind = "metadata" | "exact" | "phonetic";

export const HYBRID_SEARCH_PERMISSION_MODULE_BY_TYPE = {
  chapter: "prose",
  setting: "settings",
  character: "characters",
  race: "races",
  organization: "organizations",
  "timeline-track": "timeline",
  "timeline-event": "timeline",
  relationship: "relationships",
  "chapter-outline": "outlines",
  foreshadow: "outlines",
  review: "reviews",
  "agent-history": "ai-chat"
} as const satisfies Record<HybridSearchType, WorkPermissionModule>;

export const HYBRID_SEARCH_PERMISSION_MODULES = [
  ...new Set(HYBRID_SEARCH_TYPES.map((type) => HYBRID_SEARCH_PERMISSION_MODULE_BY_TYPE[type]))
] satisfies WorkPermissionModule[];

export function hybridSearchPermissionModule(type: unknown): WorkPermissionModule | null {
  return typeof type === "string" && HYBRID_SEARCH_TYPES.includes(type as HybridSearchType)
    ? HYBRID_SEARCH_PERMISSION_MODULE_BY_TYPE[type as HybridSearchType]
    : null;
}

export function readableHybridSearchTypes(permissions: WorkModulePermissions): HybridSearchType[] {
  return HYBRID_SEARCH_TYPES.filter((type) => canReadWorkModule(permissions, HYBRID_SEARCH_PERMISSION_MODULE_BY_TYPE[type]));
}

export type HybridSearchCandidate = {
  key: string;
  type: HybridSearchType;
  id: string;
  title: string;
  snippet: string;
  matchKind: HybridSearchMatchKind;
  subtitle?: string;
  sectionId?: string;
  startLine?: number;
  endLine?: number;
  conversationId?: string;
  messageId?: string;
};

export type HybridSearchChannel = {
  weight: number;
  candidates: HybridSearchCandidate[];
};

export type HybridSearchResult = Omit<HybridSearchCandidate, "key" | "matchKind"> & {
  score: number;
  matchKinds: HybridSearchMatchKind[];
};

const matchKindOrder: HybridSearchMatchKind[] = ["metadata", "exact", "phonetic"];
const reciprocalRankConstant = 60;

export function fuseHybridSearchChannels(channels: HybridSearchChannel[], limit = 50): HybridSearchResult[] {
  const fused = new Map<string, { candidate: HybridSearchCandidate; score: number; matchKinds: Set<HybridSearchMatchKind> }>();
  for (const channel of channels) {
    channel.candidates.forEach((candidate, index) => {
      const existing = fused.get(candidate.key);
      const score = channel.weight / (reciprocalRankConstant + index + 1);
      if (!existing) {
        fused.set(candidate.key, { candidate, score, matchKinds: new Set([candidate.matchKind]) });
        return;
      }
      existing.score += score;
      existing.matchKinds.add(candidate.matchKind);
      if (candidate.startLine !== undefined && existing.candidate.startLine === undefined) {
        existing.candidate = { ...existing.candidate, ...candidate };
      }
    });
  }
  const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
  return [...fused.values()]
    .sort((left, right) => right.score - left.score
      || left.candidate.title.localeCompare(right.candidate.title, "zh-CN")
      || left.candidate.key.localeCompare(right.candidate.key))
    .slice(0, safeLimit)
    .map(({ candidate: { key: _key, matchKind: _matchKind, ...candidate }, score, matchKinds }) => ({
      ...candidate,
      score: Number(score.toFixed(8)),
      matchKinds: matchKindOrder.filter((kind) => matchKinds.has(kind))
    }));
}

export function buildHybridSearchSnippet(value: string, query: string, maximumLength = 180): string {
  let searchableValue = value;
  try {
    const parsed = JSON.parse(value) as unknown;
    const values: string[] = [];
    const visit = (item: unknown): void => {
      if (typeof item === "string") {
        if (item.trim()) values.push(item.trim());
        return;
      }
      if (Array.isArray(item)) {
        item.forEach(visit);
        return;
      }
      if (item && typeof item === "object") Object.values(item).forEach(visit);
    };
    visit(parsed);
    if (values.length > 0) searchableValue = [...new Set(values)].join(" · ");
  } catch {
    // 普通正文无需按 JSON 结构展开。
  }
  const compact = searchableValue
    .replace(/[{}\[\]"]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!compact) return "";
  const safeMaximum = Math.max(40, Math.trunc(maximumLength));
  if (compact.length <= safeMaximum) return compact;
  const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase("zh-CN").trim();
  const normalizedCompact = compact.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const matchIndex = normalizedQuery ? normalizedCompact.indexOf(normalizedQuery) : -1;
  const start = matchIndex < 0
    ? 0
    : Math.max(0, Math.min(matchIndex - Math.floor(safeMaximum / 3), compact.length - safeMaximum));
  const excerpt = compact.slice(start, start + safeMaximum).trim();
  return `${start > 0 ? "…" : ""}${excerpt}${start + safeMaximum < compact.length ? "…" : ""}`;
}

export function documentParagraphLineRange(value: string, paragraphOrder: number): { startLine: number; endLine: number } | null {
  if (!Number.isInteger(paragraphOrder) || paragraphOrder < 0) return null;
  const lines = value.replace(/\r\n?/gu, "\n").split("\n");
  const ranges: Array<{ startLine: number; endLine: number }> = [];
  let start: number | null = null;
  for (let index = 0; index <= lines.length; index += 1) {
    const line = lines[index];
    const blank = line === undefined || /^[\t\p{Zs}\uFEFF]*$/u.test(line);
    if (!blank && start === null) start = index;
    if (blank && start !== null) {
      ranges.push({ startLine: start + 1, endLine: index });
      start = null;
    }
  }
  return ranges[paragraphOrder] ?? null;
}
