export type BackgroundTaskSummary = {
  id?: unknown;
  status?: unknown;
  taskType?: unknown;
  [key: string]: unknown;
};

export type BackgroundTaskTransition = {
  task: BackgroundTaskSummary;
  previousStatus: string;
  status: string;
};

export function backgroundTaskActivityCount(
  taskPage: { stats?: { pendingCount?: unknown; runningCount?: unknown } } | null | undefined,
  relationshipIndex: { status?: unknown; queuedSourceCount?: unknown } | null | undefined
): number;

export function collectBackgroundTaskTransitions(
  previousSnapshots: Map<string, string>,
  tasks: BackgroundTaskSummary[] | null | undefined,
  initialized: boolean
): {
  snapshots: Map<string, string>;
  transitions: BackgroundTaskTransition[];
};

export function filterBackgroundTaskTransitionsForAnnouncement(
  transitions: BackgroundTaskTransition[] | null | undefined,
  previousExpiredNoticeTimes: Map<string, number>,
  now?: number
): {
  noticeTimes: Map<string, number>;
  transitions: BackgroundTaskTransition[];
};

export function backgroundTaskPollDelay(activityCount: unknown, dialogOpen?: boolean): number;
