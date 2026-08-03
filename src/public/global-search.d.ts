export type GlobalSearchTarget =
  | { kind: "chapter"; type: "chapter"; id: string; module: "editor"; startLine?: number; endLine?: number }
  | {
      kind: "entity";
      type: "setting" | "character" | "race" | "organization" | "timeline-track" | "timeline-event" | "relationship" | "chapter-outline" | "foreshadow" | "review";
      id: string;
      module: "settings" | "characters" | "races" | "organizations" | "timeline" | "relationships" | "outlines" | "reviews";
      entity: "setting" | "character" | "race" | "organization" | "timeline-track" | "timeline-event" | "relationship" | "chapter-outline" | "foreshadow" | "review";
      apiPath: string;
    };

export function prioritizeGlobalSearchResults<T extends { type?: unknown }>(results: readonly T[]): T[];
export function splitGlobalSearchHighlight(value: unknown, query: unknown): Array<{ text: string; match: boolean }>;
export function resolveGlobalSearchTarget(result?: { type?: unknown; id?: unknown; startLine?: unknown; endLine?: unknown }): GlobalSearchTarget | null;
