import type { EncryptedSecret } from "./credential-vault.js";

/** 单个 S3 兼容备份目标（密文存储形态，落库使用）。 */
export type BackupTargetStored = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  /** 桶内子目录；为空时备份到桶根目录下的 /scriverse。 */
  subdir: string;
  enabled: boolean;
  accessKeyId: EncryptedSecret | null;
  secretAccessKey: EncryptedSecret | null;
};

/** 完整备份配置（密文存储形态，落库使用）。 */
export type BackupConfigStored = {
  targets: BackupTargetStored[];
  /** 是否同时备份图片附件。 */
  backupImages: boolean;
  /** 每日定时备份触发时间，格式 HH:MM（本地时间）。 */
  scheduleTime: string;
  /** 数据库快照保留个数，超出后删除最旧的数据库备份。 */
  retentionCount: number;
};

/** 单个 S3 备份目标（前端编辑形态）。ak/sk 为空字符串表示沿用已保存的密文。 */
export type BackupTargetClient = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  subdir: string;
  enabled: boolean;
  /** 明文或空（空代表保持不变）。 */
  accessKeyId: string;
  /** 明文或空（空代表保持不变）。 */
  secretAccessKey: string;
  /** 是否已配置 accessKeyId（仅用于前端提示）。 */
  hasAccessKeyId: boolean;
  /** 是否已配置 secretAccessKey（仅用于前端提示）。 */
  hasSecretAccessKey: boolean;
};

/** 完整备份配置（前端编辑形态）。 */
export type BackupConfigClient = {
  targets: BackupTargetClient[];
  backupImages: boolean;
  scheduleTime: string;
  retentionCount: number;
};

/** 一次备份运行中单个目标的执行结果。 */
export type BackupTargetRunResult = {
  name: string;
  ok: boolean;
  imagesUploaded: number;
  imagesSkipped: number;
  databaseFile: string | null;
  error: string | null;
};

/** 一次备份运行的汇总结果。 */
export type BackupRunResult = {
  startedAt: string;
  finishedAt: string;
  targets: BackupTargetRunResult[];
  error: string | null;
};

/** 备份服务对外暴露的实时状态。 */
export type BackupStatus = {
  running: boolean;
  lastRunAt: string | null;
  lastFinishedAt: string | null;
  lastError: string | null;
  lastResult: BackupRunResult | null;
  nextRunAt: string | null;
};
