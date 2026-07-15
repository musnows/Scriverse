export const PROVIDER_STATUSES = ["enabled", "disabled", "error"] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

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

export const ANALYSIS_STATUSES = [
  "pending",
  "running",
  "completed",
  "partial",
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
  type: "none" | "selection" | "chapter" | "volume" | "book" | "entities";
  chapterId?: string;
  volumeId?: string;
  selection?: string;
  characterIds?: string[];
  settingIds?: string[];
  includeBookSummary?: boolean;
};
