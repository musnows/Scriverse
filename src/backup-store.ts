import { Database } from "./database.js";
import { CredentialVault, type EncryptedSecret } from "./credential-vault.js";
import { id, now } from "./utils.js";

export type BackupTargetInput = {
  name: string;
  endpoint: string;
  region?: string;
  bucket: string;
  subdirectory?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  enabled?: boolean;
};

export type BackupTargetUpdateInput = {
  name?: string;
  endpoint?: string;
  region?: string;
  bucket?: string;
  subdirectory?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  enabled?: boolean;
};

export type BackupSettingsInput = {
  includeImages?: boolean;
  scheduleCron?: string;
  retentionCount?: number;
};

export type ResolvedTarget = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  subdirectory: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  enabled: boolean;
};

function maskKey(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}${"*".repeat(4)}${value.slice(-3)}`;
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export class BackupStore {
  constructor(readonly db: Database, readonly vault: CredentialVault) {}

  getSettings(): Record<string, unknown> {
    const row = this.db.get<{
      include_images: number; schedule_cron: string; retention_count: number;
      last_backup_at: string | null; last_backup_status: string | null;
      last_backup_detail_json: string; updated_at: string;
    }>("SELECT include_images, schedule_cron, retention_count, last_backup_at, last_backup_status, last_backup_detail_json, updated_at FROM s3_backup_settings WHERE id = 1");
    if (!row) {
      return { includeImages: false, scheduleCron: "", retentionCount: 0, lastBackupAt: null, lastBackupStatus: null, lastBackupDetail: {}, updatedAt: null };
    }
    return {
      includeImages: Number(row.include_images) === 1,
      scheduleCron: String(row.schedule_cron ?? ""),
      retentionCount: Number(row.retention_count ?? 0),
      lastBackupAt: row.last_backup_at ?? null,
      lastBackupStatus: row.last_backup_status ?? null,
      lastBackupDetail: parseJsonObject(row.last_backup_detail_json),
      updatedAt: String(row.updated_at ?? "")
    };
  }

  updateSettings(input: BackupSettingsInput): Record<string, unknown> {
    const current = this.getSettings();
    const next = {
      includeImages: input.includeImages === undefined ? Boolean(current.includeImages) : Boolean(input.includeImages),
      scheduleCron: input.scheduleCron === undefined ? String(current.scheduleCron) : String(input.scheduleCron),
      retentionCount: input.retentionCount === undefined ? Number(current.retentionCount) : Number(input.retentionCount)
    };
    this.db.run(
      "UPDATE s3_backup_settings SET include_images = ?, schedule_cron = ?, retention_count = ?, updated_at = ? WHERE id = 1",
      next.includeImages ? 1 : 0, next.scheduleCron, next.retentionCount, now()
    );
    return this.getSettings();
  }

  listTargets(): Record<string, unknown>[] {
    return this.db.all("SELECT * FROM s3_backup_targets ORDER BY created_at").map((row) => this.mapTarget(row));
  }

  private mapTarget(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: String(row.id),
      name: String(row.name),
      endpoint: String(row.endpoint),
      region: String(row.region ?? ""),
      bucket: String(row.bucket),
      subdirectory: String(row.subdirectory ?? ""),
      accessKeyId: maskKey(this.decryptOptional(row.access_key_id_encrypted, row.access_key_iv, row.access_key_tag)),
      secretAccessKey: "",
      forcePathStyle: Number(row.force_path_style) === 1,
      enabled: Number(row.enabled) === 1,
      lastError: row.last_error === null ? null : String(row.last_error),
      lastSuccessAt: row.last_success_at === null ? null : String(row.last_success_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private decryptOptional(encrypted: unknown, iv: unknown, tag: unknown): string {
    if (!encrypted || !iv || !tag) return "";
    try {
      return this.vault.decrypt({ encrypted: String(encrypted), iv: String(iv), tag: String(tag) });
    } catch {
      return "";
    }
  }

  resolveTarget(row: Record<string, unknown>): ResolvedTarget {
    return {
      id: String(row.id),
      name: String(row.name),
      endpoint: String(row.endpoint),
      region: String(row.region ?? ""),
      bucket: String(row.bucket),
      subdirectory: String(row.subdirectory ?? ""),
      accessKeyId: this.decryptOptional(row.access_key_id_encrypted, row.access_key_iv, row.access_key_tag),
      secretAccessKey: this.decryptOptional(row.secret_access_key_encrypted, row.secret_key_iv, row.secret_key_tag),
      forcePathStyle: Number(row.force_path_style) === 1,
      enabled: Number(row.enabled) === 1
    };
  }

  getTargetRow(targetId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM s3_backup_targets WHERE id = ?", targetId);
    if (!row) throw new Error("S3 备份目标不存在");
    return row;
  }

  listEnabledTargetRows(): Record<string, unknown>[] {
    return this.db.all("SELECT * FROM s3_backup_targets WHERE enabled = 1 ORDER BY created_at");
  }

  createTarget(input: BackupTargetInput): Record<string, unknown> {
    const targetId = id("s3target");
    const timestamp = now();
    const accessEncrypted = this.vault.encrypt(input.accessKeyId);
    const secretEncrypted = this.vault.encrypt(input.secretAccessKey);
    this.db.run(
      `INSERT INTO s3_backup_targets (id, name, endpoint, region, bucket, subdirectory,
        access_key_id_encrypted, access_key_iv, access_key_tag,
        secret_access_key_encrypted, secret_key_iv, secret_key_tag, key_hint,
        force_path_style, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      targetId, input.name, input.endpoint, input.region ?? "", input.bucket, input.subdirectory ?? "",
      accessEncrypted.encrypted, accessEncrypted.iv, accessEncrypted.tag,
      secretEncrypted.encrypted, secretEncrypted.iv, secretEncrypted.tag,
      maskKey(input.accessKeyId),
      input.forcePathStyle ? 1 : 0, input.enabled ? 1 : 0, timestamp, timestamp
    );
    const created = this.db.get("SELECT * FROM s3_backup_targets WHERE id = ?", targetId);
    return this.mapTarget(created ?? { id: targetId, name: input.name });
  }

  updateTarget(targetId: string, input: BackupTargetUpdateInput): Record<string, unknown> {
    const row = this.getTargetRow(targetId);
    const accessEncrypted: EncryptedSecret | null = input.accessKeyId ? this.vault.encrypt(input.accessKeyId) : null;
    const secretEncrypted: EncryptedSecret | null = input.secretAccessKey ? this.vault.encrypt(input.secretAccessKey) : null;
    const keyHint = input.accessKeyId ? maskKey(input.accessKeyId) : String(row.key_hint);
    this.db.run(
      `UPDATE s3_backup_targets SET name = ?, endpoint = ?, region = ?, bucket = ?, subdirectory = ?,
        access_key_id_encrypted = ?, access_key_iv = ?, access_key_tag = ?,
        secret_access_key_encrypted = ?, secret_key_iv = ?, secret_key_tag = ?, key_hint = ?,
        force_path_style = ?, enabled = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
      input.name ?? String(row.name), input.endpoint ?? String(row.endpoint),
      input.region ?? String(row.region ?? ""), input.bucket ?? String(row.bucket),
      input.subdirectory ?? String(row.subdirectory ?? ""),
      accessEncrypted ? accessEncrypted.encrypted : String(row.access_key_id_encrypted),
      accessEncrypted ? accessEncrypted.iv : String(row.access_key_iv),
      accessEncrypted ? accessEncrypted.tag : String(row.access_key_tag),
      secretEncrypted ? secretEncrypted.encrypted : String(row.secret_access_key_encrypted),
      secretEncrypted ? secretEncrypted.iv : String(row.secret_key_iv),
      secretEncrypted ? secretEncrypted.tag : String(row.secret_key_tag),
      keyHint,
      input.forcePathStyle === undefined ? Number(row.force_path_style) : input.forcePathStyle ? 1 : 0,
      input.enabled === undefined ? Number(row.enabled) : input.enabled ? 1 : 0,
      now(), targetId
    );
    const updated = this.db.get("SELECT * FROM s3_backup_targets WHERE id = ?", targetId);
    return this.mapTarget(updated ?? { id: targetId, name: String(row.name) });
  }

  deleteTarget(targetId: string): void {
    const row = this.db.get("SELECT id FROM s3_backup_targets WHERE id = ?", targetId);
    if (!row) throw new Error("S3 备份目标不存在");
    this.db.run("DELETE FROM s3_backup_targets WHERE id = ?", targetId);
  }

  recordTargetResult(targetId: string, success: boolean, error: string | null): void {
    if (success) {
      this.db.run("UPDATE s3_backup_targets SET last_error = NULL, last_success_at = ? WHERE id = ?", now(), targetId);
    } else {
      this.db.run("UPDATE s3_backup_targets SET last_error = ? WHERE id = ?", (error ?? "备份失败").slice(0, 2000), targetId);
    }
  }

  recordBackupResult(status: string, detail: Record<string, unknown>): void {
    this.db.run(
      "UPDATE s3_backup_settings SET last_backup_at = ?, last_backup_status = ?, last_backup_detail_json = ?, updated_at = ? WHERE id = 1",
      now(), status, JSON.stringify(detail), now()
    );
  }
}
