export type TimelineSortDirection = "asc" | "desc";

export type TimelineViewEvent = {
  id?: string | null;
  trackId?: string | null;
  timeSort?: number | null;
  updatedAt?: string | null;
};

export type TimelineViewTrack = {
  id?: string | null;
  name?: string | null;
  sortOrder?: number | null;
};

export declare const TIMELINE_TRACK_PALETTE_SIZE: number;
export declare const TIMELINE_UNGROUPED_COLOR_INDEX: number;

export declare function normalizeTimelineSortDirection(direction?: unknown): TimelineSortDirection;

export declare function sortTimelineEvents<T extends TimelineViewEvent>(
  events?: T[],
  options?: { direction?: TimelineSortDirection }
): T[];

export declare function filterTimelineEvents<T extends TimelineViewEvent>(
  events?: T[],
  filters?: { trackIds?: Array<string | null | undefined> }
): T[];

export declare function timelineTrackColorIndex(
  trackId: string | null | undefined,
  tracks?: TimelineViewTrack[]
): number;

export declare function prepareTimelineEvents<T extends TimelineViewEvent>(
  events?: T[],
  filters?: { trackIds?: Array<string | null | undefined> },
  options?: { direction?: TimelineSortDirection }
): T[];

export declare function resolveTimelineActiveTrackId(
  activeTrackId: string | null | undefined,
  tracks?: TimelineViewTrack[]
): string;

export declare function timelineTrackDisplayName(
  trackId: string | null | undefined,
  tracks?: TimelineViewTrack[]
): string;
