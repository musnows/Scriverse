export type ForeshadowReminder = {
  foreshadowId: string;
  occurrenceId: string;
  title: string;
  description: string;
  status: "planned" | "planted";
  importance: "low" | "medium" | "high";
  role: "reminder" | "payoff";
  note: string;
  versionNo: number;
  updatedAt: string;
};

export const FORESHADOW_REMINDER_SNOOZE_STORAGE_KEY: string;
export function normalizeForeshadowReminders(value: unknown): ForeshadowReminder[];
export function foreshadowReminderSnoozeKey(
  workId: unknown,
  chapterId: unknown,
  reminder: Partial<ForeshadowReminder> | null | undefined
): string | null;
export function parseForeshadowReminderSnoozes(serialized: unknown): Set<string>;
export function serializeForeshadowReminderSnoozes(snoozes: ReadonlySet<string>, limit?: number): string;
export function visibleForeshadowReminders(
  reminders: unknown,
  workId: unknown,
  chapterId: unknown,
  snoozes: ReadonlySet<string>
): ForeshadowReminder[];
export function foreshadowReminderRequestTargetsState(
  request: { workId: unknown; chapterId: unknown } | null | undefined,
  current: { workId?: unknown; chapterId?: unknown } | null | undefined
): boolean;
