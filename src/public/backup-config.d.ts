export type BackupConfigSummary = {
  bucket?: unknown;
  pathPrefix?: unknown;
  forcePathStyle?: unknown;
  scheduleTime?: unknown;
  retentionCount?: unknown;
  includeImages?: unknown;
  [key: string]: unknown;
};

export type BackupRunSummary = {
  configName?: unknown;
  error?: unknown;
  finishedAt?: unknown;
  [key: string]: unknown;
};

export function backupRunStatusLabel(status: string): string;

export function backupRunTriggerLabel(trigger: string): string;

export function backupConfigTargetSummary(config?: BackupConfigSummary | null): string;

export function backupConfigScheduleSummary(config?: BackupConfigSummary | null): string;

export function nextBackupAlertWatermark(
  runs: BackupRunSummary[] | null | undefined,
  currentWatermark: string | null | undefined
): string | null;

export function backupFailureToastMessage(run?: BackupRunSummary | null): string;
