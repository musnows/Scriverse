export const PROVIDER_STATUSES = ["enabled", "disabled", "error"] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const DRAFT_SETTING_MODULES = [
  "settings",
  "characters",
  "races",
  "organizations",
  "timeline",
  "relationships",
  "outlines"
] as const;
export type DraftSettingModule = (typeof DRAFT_SETTING_MODULES)[number];

export const TASK_TYPES = [
  "chat",
  "continue",
  "polish",
  "chapter-analysis",
  "book-analysis",
  "timeline-analysis",
  "relationship-analysis",
  "consistency-check"
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const ANALYSIS_TASK_TYPES = [
  "structure",
  "chapter-analysis",
  "character-extraction",
  "character-summary",
  "character-identity-audit",
  "timeline-analysis",
  "relationship-analysis",
  "worldview-analysis",
  "setting-extraction",
  "consistency-check",
  "report-update",
  "book-analysis"
] as const;
export type AnalysisTaskType = (typeof ANALYSIS_TASK_TYPES)[number];

export const ANALYSIS_STATUSES = [
  "pending",
  "running",
  "completed",
  "partial",
  "failed",
  "review",
  "expired",
  "cancelled"
] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export type ParsedChapter = {
  title: string;
  content: string;
  order: number;
  chapterType: "正文" | "设定" | "作者的话" | "其他";
};

export type ParsedVolume = {
  title: string;
  kind: "main" | "prequel" | "extra" | "epilogue" | "appendix";
  source: "explicit" | "default";
  order: number;
  chapters: ParsedChapter[];
};

export type ParsedNovel = {
  volumes: ParsedVolume[];
  warnings: string[];
  wordCount: number;
  paragraphCount: number;
};

export type AiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ContextScope = {
  type: "none" | "selection" | "chapter" | "volume" | "book" | "settings" | "settings-catalog" | "entities";
  chapterId?: string;
  volumeId?: string;
  selection?: string;
  chapterIds?: string[];
  characterIds?: string[];
  /** 指令关键词命中的角色（轻量卡，不含档案 Markdown 全文）。 */
  mentionCharacterIds?: string[];
  settingIds?: string[];
  raceIds?: string[];
  organizationIds?: string[];
  includeBookSummary?: boolean;
  /** 正文范围内是否注入锁定设定、组织/种族简表等；缺省为 true。设定库范围忽略此字段。 */
  includeSettingInfo?: boolean;
  includeAllSettings?: boolean;
  additionalPrompt?: string;
  preFilterRelationshipSources?: boolean;
  previewRelationshipChanges?: boolean;
  relationshipSourceRefs?: Array<{ sourceType: string; sourceId: string; sourceVersion: string }>;
  replaceExistingRelationships?: boolean;
  excludeRelationshipConstraints?: boolean;
  suppressAutomaticContext?: boolean;
};

export type AiInjectedEntities = {
  characters: string[];
  races: string[];
  organizations: string[];
};
