import { randomUUID } from "node:crypto";
import { CredentialVault, type EncryptedSecret } from "./credential-vault.js";
import { Database, PLATFORM_AI_WORK_ID, type Row } from "./database.js";
import { AppError } from "./errors.js";
import { Store } from "./store.js";

export type S3BackupTargetInput = {
  name: string;
  endpoint: string;
  region?: string;
  bucket: string;
  basePath?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  enabled?: boolean;
  backupImages?: boolean;
  scheduleTime?: string;
  retentionCount?: number;
};

export type S3BackupTargetUpdate = Partial<S3BackupTargetInput>;

export type S3BackupTarget = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  basePath: string;
  rootPrefix: string;
  forcePathStyle: boolean;
  enabled: boolean;
  backupImages: boolean;
  scheduleTime: string;
  retentionCount: number;
  credentialsConfigured: true;
  lastStartedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new AppError(500, "BACKUP_TARGET_INVALID", `S3 备份配置字段 ${key} 无效`);
  return value;
}

function nullableString(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function encryptedSecret(row: Row, prefix: "access_key" | "secret_key"): EncryptedSecret {
  return {
    encrypted: requiredString(row, `${prefix}_encrypted`),
    iv: requiredString(row, `${prefix}_iv`),
    tag: requiredString(row, `${prefix}_tag`)
  };
}

export function normalizeS3BasePath(value = ""): string {
  return value.trim().replace(/^\/+|\/+$/gu, "").replace(/\/{2,}/gu, "/");
}

export function s3BackupRootPrefix(basePath = ""): string {
  const normalized = normalizeS3BasePath(basePath);
  return normalized ? `${normalized}/scriverse` : "scriverse";
}

function normalizedEndpoint(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/gu, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

export class S3BackupManager {
  constructor(
    private readonly database: Database,
    private readonly vault: CredentialVault,
    private readonly store: Store
  ) {}

  listTargets(): S3BackupTarget[] {
    return this.database.all("SELECT * FROM s3_backup_targets ORDER BY created_at, id").map((row) => this.mapTarget(row));
  }

  getTarget(targetId: string): S3BackupTarget {
    return this.mapTarget(this.requireTargetRow(targetId));
  }

  createTarget(input: S3BackupTargetInput): S3BackupTarget {
    const targetId = randomUUID();
    const timestamp = new Date().toISOString();
    const accessKey = this.vault.encrypt(input.accessKeyId);
    const secretKey = this.vault.encrypt(input.secretAccessKey);
    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO s3_backup_targets (
          id, name, endpoint, region, bucket, base_path,
          access_key_encrypted, access_key_iv, access_key_tag,
          secret_key_encrypted, secret_key_iv, secret_key_tag,
          force_path_style, enabled, backup_images, schedule_time, retention_count,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        targetId,
        input.name.trim(),
        normalizedEndpoint(input.endpoint),
        input.region?.trim() || "us-east-1",
        input.bucket.trim(),
        normalizeS3BasePath(input.basePath),
        accessKey.encrypted,
        accessKey.iv,
        accessKey.tag,
        secretKey.encrypted,
        secretKey.iv,
        secretKey.tag,
        input.forcePathStyle === false ? 0 : 1,
        input.enabled === true ? 1 : 0,
        input.backupImages === false ? 0 : 1,
        input.scheduleTime ?? "03:00",
        input.retentionCount ?? 7,
        timestamp,
        timestamp
      );
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup-target.created", "s3-backup-target", targetId, {
        ...this.sanitizedInput(input),
        rootPrefix: s3BackupRootPrefix(input.basePath)
      });
    });
    return this.getTarget(targetId);
  }

  updateTarget(targetId: string, input: S3BackupTargetUpdate): S3BackupTarget {
    const current = this.requireTargetRow(targetId);
    const accessKey = input.accessKeyId === undefined ? encryptedSecret(current, "access_key") : this.vault.encrypt(input.accessKeyId);
    const secretKey = input.secretAccessKey === undefined ? encryptedSecret(current, "secret_key") : this.vault.encrypt(input.secretAccessKey);
    const timestamp = new Date().toISOString();
    this.database.transaction(() => {
      this.database.run(
        `UPDATE s3_backup_targets SET
          name = ?, endpoint = ?, region = ?, bucket = ?, base_path = ?,
          access_key_encrypted = ?, access_key_iv = ?, access_key_tag = ?,
          secret_key_encrypted = ?, secret_key_iv = ?, secret_key_tag = ?,
          force_path_style = ?, enabled = ?, backup_images = ?, schedule_time = ?, retention_count = ?, updated_at = ?
         WHERE id = ?`,
        input.name?.trim() ?? requiredString(current, "name"),
        input.endpoint === undefined ? requiredString(current, "endpoint") : normalizedEndpoint(input.endpoint),
        input.region?.trim() ?? requiredString(current, "region"),
        input.bucket?.trim() ?? requiredString(current, "bucket"),
        input.basePath === undefined ? requiredString(current, "base_path") : normalizeS3BasePath(input.basePath),
        accessKey.encrypted,
        accessKey.iv,
        accessKey.tag,
        secretKey.encrypted,
        secretKey.iv,
        secretKey.tag,
        input.forcePathStyle === undefined ? Number(current.force_path_style) : input.forcePathStyle ? 1 : 0,
        input.enabled === undefined ? Number(current.enabled) : input.enabled ? 1 : 0,
        input.backupImages === undefined ? Number(current.backup_images) : input.backupImages ? 1 : 0,
        input.scheduleTime ?? requiredString(current, "schedule_time"),
        input.retentionCount ?? Number(current.retention_count),
        timestamp,
        targetId
      );
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup-target.updated", "s3-backup-target", targetId, {
        fields: Object.keys(input).filter((key) => key !== "accessKeyId" && key !== "secretAccessKey"),
        credentialsUpdated: input.accessKeyId !== undefined || input.secretAccessKey !== undefined
      });
    });
    return this.getTarget(targetId);
  }

  deleteTarget(targetId: string): void {
    const current = this.requireTargetRow(targetId);
    this.database.transaction(() => {
      this.database.run("DELETE FROM s3_backup_targets WHERE id = ?", targetId);
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup-target.deleted", "s3-backup-target", targetId, {
        name: requiredString(current, "name"),
        endpoint: requiredString(current, "endpoint"),
        bucket: requiredString(current, "bucket"),
        basePath: requiredString(current, "base_path")
      });
    });
  }

  private requireTargetRow(targetId: string): Row {
    const row = this.database.get("SELECT * FROM s3_backup_targets WHERE id = ?", targetId);
    if (!row) throw new AppError(404, "BACKUP_TARGET_NOT_FOUND", "S3 备份目标不存在");
    return row;
  }

  private mapTarget(row: Row): S3BackupTarget {
    const basePath = requiredString(row, "base_path");
    return {
      id: requiredString(row, "id"),
      name: requiredString(row, "name"),
      endpoint: requiredString(row, "endpoint"),
      region: requiredString(row, "region"),
      bucket: requiredString(row, "bucket"),
      basePath,
      rootPrefix: s3BackupRootPrefix(basePath),
      forcePathStyle: Number(row.force_path_style) === 1,
      enabled: Number(row.enabled) === 1,
      backupImages: Number(row.backup_images) === 1,
      scheduleTime: requiredString(row, "schedule_time"),
      retentionCount: Number(row.retention_count),
      credentialsConfigured: true,
      lastStartedAt: nullableString(row, "last_started_at"),
      lastSuccessAt: nullableString(row, "last_success_at"),
      lastFailureAt: nullableString(row, "last_failure_at"),
      lastError: nullableString(row, "last_error"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private sanitizedInput(input: S3BackupTargetInput): Record<string, unknown> {
    return {
      name: input.name.trim(),
      endpoint: normalizedEndpoint(input.endpoint),
      region: input.region?.trim() || "us-east-1",
      bucket: input.bucket.trim(),
      basePath: normalizeS3BasePath(input.basePath),
      forcePathStyle: input.forcePathStyle !== false,
      enabled: input.enabled === true,
      backupImages: input.backupImages !== false,
      scheduleTime: input.scheduleTime ?? "03:00",
      retentionCount: input.retentionCount ?? 7
    };
  }
}
