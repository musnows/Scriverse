export type S3BackupRunSnapshot = {
  id: string;
  status: string;
  targetName?: string;
  errorMessage?: string | null;
  [key: string]: unknown;
};

export function s3BackupRootPrefix(basePath?: string): string;
export function s3BackupStatusLabel(status: string): string;
export function collectS3BackupRunTransitions<T extends S3BackupRunSnapshot>(
  previousSnapshots: ReadonlyMap<string, string>,
  runs: T[],
  initialized: boolean,
  maximumSnapshots?: number
): { snapshots: Map<string, string>; failures: T[] };
export function s3BackupFailureToast(run: Pick<S3BackupRunSnapshot, "targetName" | "errorMessage">): string;
