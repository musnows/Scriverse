export type AiUsageCalendarCell = {
  date: string;
  totalTokens: number;
  future: boolean;
  week: number;
  weekday: number;
  level: number;
};

export function formatTokenCount(value: unknown): string;
export function formatCacheHitRate(value: unknown): string;
export function formatEstimatedCost(value: unknown): string;
export function buildUsageCalendar(
  daily: Array<{ date: string; totalTokens: number }> | unknown,
  today?: Date,
  weekCount?: number
): {
  cells: AiUsageCalendarCell[];
  months: Array<{ week: number; label: string }>;
  weekCount: number;
};
