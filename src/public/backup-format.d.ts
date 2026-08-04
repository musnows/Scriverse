export type BackupTargetResultView = {
  targetId?: string;
  targetName?: string;
  status?: string;
  databaseUploaded?: boolean;
  uploadedImageCount?: number;
  skippedImageCount?: number;
  failedImageCount?: number;
  deletedBackupCount?: number;
  error?: BackupFailureView | null;
};

export type BackupFailureView = {
  httpStatus?: number | null;
  s3Code?: string;
  s3Message?: string;
  message?: string;
};

export type BackupRunView = {
  id?: string;
  trigger?: string;
  status?: string;
  results?: BackupTargetResultView[];
};

export function formatBackupBytes(value?: number | string | null): string;
export function backupRunStatusLabel(status?: string): string;
export function backupTargetStatusLabel(status?: string): string;
export function backupConnectionStatusLabel(status?: string): string;
export function backupTriggerLabel(trigger?: string): string;
export function backupTargetPathSummary(target?: { objectRoot?: string } | null): string;
export function backupTargetResultSummary(result?: BackupTargetResultView | null): string;
export function backupFailureSummary(error?: BackupFailureView | null): string;
export function backupAlertMessage(run?: BackupRunView | null): string;
