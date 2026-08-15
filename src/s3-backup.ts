import { createHash, createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import type { AttachmentStorage } from "./attachment-storage.js";
import type { CredentialVault } from "./credential-vault.js";
import { PLATFORM_AI_WORK_ID, type Row } from "./database.js";
import { AppError, notFound } from "./errors.js";
import { logger, sanitizeError } from "./logger.js";
import { fetchSafeAiEndpoint } from "./security.js";
import type { Store } from "./store.js";
import { id, json, now } from "./utils.js";

const backupDbFileNamePattern = /^novel-\d{8}T\d{6}\.\d{3}Z(?:-\d+)?\.db$/u;
const attachmentStorageKeyPattern = /^[a-f0-9]{2}\/[a-f0-9]{64}\.(?:webp|png|jpe?g|gif)$/u;
const s3RequestTimeoutMs = 120_000;

export type S3BackupRunTrigger = "scheduled" | "manual";
export type S3BackupRunStatus = "running" | "success" | "partial" | "failed";

export type S3BackupSettingsInput = {
  enabled?: boolean;
  backupImages?: boolean;
  scheduleTime?: string;
  retentionCount?: number;
};

export type S3BackupTargetInput = {
  name?: string;
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  enabled?: boolean;
  accessKey?: string;
  secretKey?: string;
};

type StoredTarget = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  enabled: boolean;
  encryptedAccessKey: string;
  accessKeyIv: string;
  accessKeyTag: string;
  encryptedSecretKey: string;
  secretKeyIv: string;
  secretKeyTag: string;
  createdAt: string;
  updatedAt: string;
};

type ResolvedTarget = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKey: string;
  secretKey: string;
  createdAt: string;
  updatedAt: string;
};

type S3ClientQuery = Record<string, string>;

export class S3BackupRequestError extends Error {
  constructor(
    readonly method: string,
    readonly key: string,
    readonly status: number,
    readonly code: string,
    readonly body: string,
    readonly headers: Record<string, string>
  ) {
    const summary = body.trim().slice(0, 400);
    super(`S3 ${method} ${key || "/"} failed with HTTP ${status}${code ? ` (${code})` : ""}${summary ? `: ${summary}` : ""}`);
    this.name = "S3BackupRequestError";
  }
}

function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

export function s3UsesVirtualHostedStyle(endpoint: string, bucket: string): boolean {
  if (bucket.includes(".")) return false;
  const hostname = new URL(endpoint).hostname.toLocaleLowerCase();
  return hostname === "s3.amazonaws.com" || /^s3[.-][a-z0-9-]+\.amazonaws\.com$/u.test(hostname);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function amzTimestamp(value: Date): { timestamp: string; date: string } {
  const timestamp = value.toISOString().replace(/[:-]/gu, "").replace(/\.\d{3}/u, "");
  return { timestamp, date: timestamp.slice(0, 8) };
}

function parseS3ErrorBody(body: string): { code: string; message: string } {
  const code = body.match(/<Code>([\s\S]*?)<\/Code>/u)?.[1]?.trim() ?? "";
  const message = body.match(/<Message>([\s\S]*?)<\/Message>/u)?.[1]?.trim() ?? body.trim();
  return { code, message };
}

class S3Client {
  private readonly endpoint: URL;

  constructor(
    private readonly target: ResolvedTarget,
    private readonly fetchImpl: typeof fetch,
    private readonly validateOutboundUrl?: (url: string) => Promise<readonly { address: string; family: 4 | 6 }[] | void>
  ) {
    this.endpoint = new URL(target.endpoint);
  }

  async headObject(key: string): Promise<boolean> {
    const response = await this.request("HEAD", key);
    return response.status !== 404;
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.request("PUT", key, { body, contentType });
  }

  async deleteObject(key: string): Promise<void> {
    await this.request("DELETE", key);
  }

  async listObjectKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken = "";
    while (true) {
      const query: S3ClientQuery = {
        "list-type": "2",
        prefix,
        "max-keys": "1000"
      };
      if (continuationToken) query["continuation-token"] = continuationToken;
      const response = await this.request("GET", "", { query });
      const text = await response.text();
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new S3BackupRequestError("GET", prefix, 200, "INVALID_JSON", text, this.responseHeaders(response));
      }
      const contents = Array.isArray(payload.Contents) ? payload.Contents : [];
      for (const item of contents) {
        if (item && typeof item === "object" && typeof (item as Record<string, unknown>).Key === "string") {
          keys.push(String((item as Record<string, unknown>).Key));
        }
      }
      const truncated = payload.IsTruncated === true || String(payload.IsTruncated) === "true";
      if (!truncated) return keys;
      continuationToken = String(payload.NextContinuationToken ?? "");
      if (!continuationToken) return keys;
    }
  }

  private responseHeaders(response: Response): Record<string, string> {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return headers;
  }

  private async request(
    method: string,
    key: string,
    options: { query?: S3ClientQuery; body?: Buffer; contentType?: string } = {}
  ): Promise<Response> {
    const endpointPath = this.endpoint.pathname.replace(/\/+$/u, "");
    const encodedBucket = awsUriEncode(this.target.bucket);
    const encodedKey = key ? key.split("/").map((segment) => awsUriEncode(segment)).join("/") : "";
    const virtualHostedStyle = s3UsesVirtualHostedStyle(this.target.endpoint, this.target.bucket);
    const url = new URL(this.endpoint.href);
    if (virtualHostedStyle) {
      url.hostname = `${this.target.bucket}.${this.endpoint.hostname}`;
      url.port = this.endpoint.port;
      url.pathname = `${endpointPath}/${encodedKey}` || "/";
    } else {
      const pathname = `${endpointPath}/${encodedBucket}/${encodedKey}`;
      url.pathname = pathname || "/";
    }
    const queryPairs = Object.entries(options.query ?? {})
      .map(([name, value]) => [awsUriEncode(name), awsUriEncode(value)] as const)
      .sort(([leftName, leftValue], [rightName, rightValue]) => (
        leftName === rightName ? leftValue.localeCompare(rightValue) : leftName.localeCompare(rightName)
      ));
    const canonicalQuery = queryPairs.map(([name, value]) => `${name}=${value}`).join("&");
    url.search = canonicalQuery ? `?${canonicalQuery}` : "";
    const payload = options.body ?? Buffer.alloc(0);
    const payloadHash = sha256(payload);
    const date = amzTimestamp(new Date());
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": date.timestamp
    };
    if (options.contentType) headers["content-type"] = options.contentType;
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers).sort()
      .map((name) => `${name}:${headers[name]?.trim() ?? ""}\n`)
      .join("");
    const canonicalRequest = [
      method,
      url.pathname || "/",
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join("\n");
    const scope = `${date.date}/${this.target.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", date.timestamp, scope, sha256(canonicalRequest)].join("\n");
    const signingKey = hmac(
      hmac(
        hmac(
          hmac(`AWS4${this.target.secretKey}`, date.date),
          this.target.region
        ),
        "s3"
      ),
      "aws4_request"
    );
    const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.target.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    let response: Response;
    try {
      response = await fetchSafeAiEndpoint(
        this.fetchImpl,
        url.toString(),
        {
          method,
          headers,
          ...(options.body ? { body: options.body as unknown as BodyInit } : {}),
          signal: AbortSignal.timeout(s3RequestTimeoutMs)
        },
        this.validateOutboundUrl
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw new S3BackupRequestError(method, key, error.status, error.code, error.message, {});
      }
      throw error;
    }
    if (method === "HEAD") {
      if (response.status === 404) return response;
      if (response.status >= 200 && response.status < 300) return response;
    } else if (response.status >= 200 && response.status < 300) {
      return response;
    }
    const body = await response.text();
    const parsed = parseS3ErrorBody(body);
    throw new S3BackupRequestError(
      method,
      key,
      response.status,
      parsed.code,
      parsed.message ? `${parsed.code}: ${parsed.message}` : body,
      this.responseHeaders(response)
    );
  }
}

function contentTypeForStorageKey(storageKey: string): string {
  const extension = storageKey.slice(storageKey.lastIndexOf(".") + 1).toLocaleLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "gif") return "image/gif";
  return "image/webp";
}

export function formatS3BackupDbFileName(value = new Date(), sequence = 0): string {
  const timestamp = value.toISOString().replace(/[:-]/gu, "");
  return `novel-${timestamp}${sequence > 0 ? `-${sequence}` : ""}.db`;
}

export function normalizeS3BackupPrefix(value: string): string {
  return value.split("/").map((segment) => segment.trim()).filter(Boolean).join("/");
}

export function s3BackupTargetLogFields(target: Row): Record<string, unknown> {
  const field = (snakeKey: string, camelKey: string): string => String(target[snakeKey] ?? target[camelKey] ?? "");
  return {
    id: field("id", "id"),
    name: field("name", "name"),
    endpoint: field("endpoint", "endpoint"),
    region: field("region", "region"),
    bucket: field("bucket", "bucket"),
    prefix: field("prefix", "prefix"),
    enabled: Number(target.enabled) === 1,
    createdAt: field("created_at", "createdAt"),
    updatedAt: field("updated_at", "updatedAt")
  };
}

export function selectS3BackupRetentionDeletes(keys: string[], prefix: string, retentionCount: number): string[] {
  const normalizedPrefix = normalizeS3BackupPrefix(prefix).replace(/\/$/u, "");
  const candidates = keys.flatMap((key) => {
    const remainder = normalizedPrefix ? key.startsWith(`${normalizedPrefix}/`) ? key.slice(normalizedPrefix.length + 1) : "" : key;
    if (!remainder || remainder.includes("/")) return [];
    return backupDbFileNamePattern.test(remainder) ? [{ key, name: remainder }] : [];
  }).sort((left, right) => left.name.localeCompare(right.name));
  const excess = candidates.length - Math.max(0, Math.floor(retentionCount));
  return excess > 0 ? candidates.slice(0, excess).map((candidate) => candidate.key) : [];
}

export function nextBackupScheduleDelay(scheduleTime: string, nowValue = new Date()): number {
  const match = scheduleTime.match(/^([01]\d|2[0-3]):([0-5]\d)$/u);
  const hours = match ? Number(match[1]) : 3;
  const minutes = match ? Number(match[2]) : 0;
  const next = new Date(nowValue.getTime());
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= nowValue.getTime()) next.setDate(next.getDate() + 1);
  return Math.max(0, next.getTime() - nowValue.getTime());
}

export function splitS3BackupLogText(fieldName: string, value: string): Record<string, unknown> {
  if (value.length <= 3_000) return { [fieldName]: value };
  const result: Record<string, unknown> = { [`${fieldName}Length`]: value.length };
  const partCount = Math.ceil(value.length / 3_000);
  for (let index = 0; index < partCount; index += 1) {
    result[`${fieldName}Part${index + 1}`] = value.slice(index * 3_000, (index + 1) * 3_000);
  }
  return result;
}

type BackupPrefixes = { root: string; images: string; database: string };

type BackupRunTargetResult = {
  targetId: string;
  targetName: string;
  status: "success" | "failed";
  images?: { scanned: number; skipped: number; uploaded: number };
  database?: { key: string; retentionDeleted: number };
  error?: { stage: string; message: string; status?: number; code?: string };
};

type DatabaseSnapshot = { path: string; directory: string; fileName: string; createdAt: Date };

export class S3BackupManager {
  private scheduleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private activeRunPromise: Promise<Record<string, unknown>> | null = null;

  constructor(
    private readonly store: Store,
    private readonly vault: CredentialVault,
    private readonly attachmentStorage: AttachmentStorage,
    private readonly databasePath: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly validateOutboundUrl?: (url: string) => Promise<readonly { address: string; family: 4 | 6 }[] | void>
  ) {}

  start(): void {
    this.armSchedule();
  }

  dispose(): void {
    this.disposed = true;
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = null;
  }

  getConfig(): Record<string, unknown> {
    return {
      settings: this.getSettings(),
      targets: this.listTargets(),
      latestRun: this.getLatestRun()
    };
  }

  getSettings(): Record<string, unknown> {
    const row = this.store.db.get("SELECT * FROM platform_s3_backup_settings WHERE id = 1");
    return {
      enabled: Number(row?.enabled) === 1,
      backupImages: Number(row?.backup_images) === 1,
      scheduleTime: String(row?.schedule_time ?? "03:00"),
      retentionCount: Math.max(1, Number(row?.retention_count ?? 30)),
      updatedAt: String(row?.updated_at ?? "")
    };
  }

  updateSettings(input: S3BackupSettingsInput): Record<string, unknown> {
    const current = this.getSettings();
    const enabled = input.enabled ?? current.enabled === true;
    const backupImages = input.backupImages ?? current.backupImages === true;
    const scheduleTime = input.scheduleTime ?? String(current.scheduleTime);
    const retentionCount = input.retentionCount ?? Number(current.retentionCount);
    const timestamp = now();
    this.store.db.run(
      `INSERT INTO platform_s3_backup_settings (id, enabled, backup_images, schedule_time, retention_count, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled,
         backup_images = excluded.backup_images,
         schedule_time = excluded.schedule_time,
         retention_count = excluded.retention_count,
         updated_at = excluded.updated_at`,
      enabled ? 1 : 0,
      backupImages ? 1 : 0,
      scheduleTime,
      retentionCount,
      timestamp
    );
    this.store.audit(PLATFORM_AI_WORK_ID, "platform.s3-backup.settings.updated", "platform-s3-backup", "settings", {
      enabled,
      backupImages,
      scheduleTime,
      retentionCount
    });
    this.armSchedule();
    return this.getSettings();
  }

  async createTarget(input: Required<Pick<S3BackupTargetInput, "name" | "endpoint" | "bucket" | "accessKey" | "secretKey">> & Omit<S3BackupTargetInput, "name" | "endpoint" | "bucket" | "accessKey" | "secretKey">): Promise<Record<string, unknown>> {
    const endpoint = input.endpoint;
    await this.assertSafeTargetEndpoint(endpoint);
    const targetId = id("s3target");
    const timestamp = now();
    const accessKey = this.vault.encrypt(input.accessKey);
    const secretKey = this.vault.encrypt(input.secretKey);
    this.store.db.run(
      `INSERT INTO s3_backup_targets (
         id, name, endpoint, region, bucket, prefix, enabled,
         encrypted_access_key, access_key_iv, access_key_tag,
         encrypted_secret_key, secret_key_iv, secret_key_tag,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      targetId,
      input.name,
      endpoint,
      input.region ?? "us-east-1",
      input.bucket,
      normalizeS3BackupPrefix(input.prefix ?? ""),
      input.enabled === true ? 1 : 0,
      accessKey.encrypted,
      accessKey.iv,
      accessKey.tag,
      secretKey.encrypted,
      secretKey.iv,
      secretKey.tag,
      timestamp,
      timestamp
    );
    this.store.audit(PLATFORM_AI_WORK_ID, "platform.s3-backup.target.created", "platform-s3-backup", targetId, {
      name: input.name,
      endpoint,
      region: input.region ?? "us-east-1",
      bucket: input.bucket,
      prefix: normalizeS3BackupPrefix(input.prefix ?? ""),
      enabled: input.enabled === true
    });
    return this.getTarget(targetId);
  }

  listTargets(): Record<string, unknown>[] {
    return this.storedTargets().map((target) => this.targetView(target));
  }

  getTarget(targetId: string): Record<string, unknown> {
    const row = this.store.db.get("SELECT * FROM s3_backup_targets WHERE id = ?", targetId);
    if (!row) throw notFound("S3 备份目标");
    return this.targetView(this.storedTarget(row));
  }

  async updateTarget(targetId: string, input: S3BackupTargetInput): Promise<Record<string, unknown>> {
    const row = this.store.db.get("SELECT * FROM s3_backup_targets WHERE id = ?", targetId);
    if (!row) throw notFound("S3 备份目标");
    const stored = this.storedTarget(row);
    const endpoint = input.endpoint ?? stored.endpoint;
    await this.assertSafeTargetEndpoint(endpoint);
    const accessKey = input.accessKey ? this.vault.encrypt(input.accessKey) : null;
    const secretKey = input.secretKey ? this.vault.encrypt(input.secretKey) : null;
    const timestamp = now();
    this.store.db.run(
      `UPDATE s3_backup_targets SET
         name = ?, endpoint = ?, region = ?, bucket = ?, prefix = ?, enabled = ?,
         encrypted_access_key = COALESCE(?, encrypted_access_key),
         access_key_iv = COALESCE(?, access_key_iv),
         access_key_tag = COALESCE(?, access_key_tag),
         encrypted_secret_key = COALESCE(?, encrypted_secret_key),
         secret_key_iv = COALESCE(?, secret_key_iv),
         secret_key_tag = COALESCE(?, secret_key_tag),
         updated_at = ?
       WHERE id = ?`,
      input.name ?? stored.name,
      endpoint,
      input.region ?? stored.region,
      input.bucket ?? stored.bucket,
      normalizeS3BackupPrefix(input.prefix ?? stored.prefix),
      input.enabled === undefined ? (stored.enabled ? 1 : 0) : (input.enabled ? 1 : 0),
      accessKey?.encrypted ?? null,
      accessKey?.iv ?? null,
      accessKey?.tag ?? null,
      secretKey?.encrypted ?? null,
      secretKey?.iv ?? null,
      secretKey?.tag ?? null,
      timestamp,
      targetId
    );
    this.store.audit(PLATFORM_AI_WORK_ID, "platform.s3-backup.target.updated", "platform-s3-backup", targetId, {
      fields: Object.keys(input).filter((key) => key !== "accessKey" && key !== "secretKey"),
      accessKeyReplaced: Boolean(input.accessKey),
      secretKeyReplaced: Boolean(input.secretKey)
    });
    return this.getTarget(targetId);
  }

  deleteTarget(targetId: string): void {
    const row = this.store.db.get("SELECT id, name FROM s3_backup_targets WHERE id = ?", targetId);
    if (!row) throw notFound("S3 备份目标");
    this.store.db.run("DELETE FROM s3_backup_targets WHERE id = ?", targetId);
    this.store.audit(PLATFORM_AI_WORK_ID, "platform.s3-backup.target.deleted", "platform-s3-backup", targetId, {
      name: String(row.name ?? "")
    });
  }

  markFailureNotified(runId: string): Record<string, unknown> {
    const run = this.store.db.get("SELECT * FROM s3_backup_runs WHERE id = ?", runId);
    if (!run) throw notFound("备份任务");
    this.store.db.run("UPDATE s3_backup_runs SET failure_notified = 1 WHERE id = ?", runId);
    const updated = this.store.db.get("SELECT * FROM s3_backup_runs WHERE id = ?", runId);
    return this.runView(updated ?? run);
  }

  async runOnce(trigger: S3BackupRunTrigger): Promise<Record<string, unknown>> {
    if (this.activeRunPromise) throw new AppError(409, "S3_BACKUP_RUNNING", "已有备份任务正在执行");
    const targets = this.storedTargets().filter((target) => target.enabled);
    if (targets.length === 0) throw new AppError(400, "S3_BACKUP_TARGET_REQUIRED", "请先配置并启用至少一个 S3 备份目标");
    const runId = id("s3run");
    const startedAt = now();
    this.store.db.run(
      `INSERT INTO s3_backup_runs (id, trigger, status, started_at, result_json)
       VALUES (?, ?, 'running', ?, '{}')`,
      runId,
      trigger,
      startedAt
    );
    const promise = this.executeRun(runId, trigger, targets).finally(() => {
      this.activeRunPromise = null;
    });
    this.activeRunPromise = promise;
    return promise;
  }

  private async executeRun(
    runId: string,
    trigger: S3BackupRunTrigger,
    targets: StoredTarget[]
  ): Promise<Record<string, unknown>> {
    const settings = this.getSettings();
    const results: BackupRunTargetResult[] = [];
    let snapshot: DatabaseSnapshot | null = null;
    let globalError: { stage: string; message: string } | null = null;
    try {
      snapshot = this.createDatabaseSnapshot(formatS3BackupDbFileName());
      for (const target of targets) {
        results.push(await this.backupTarget(target, settings, snapshot));
      }
    } catch (error) {
      globalError = {
        stage: "local",
        message: error instanceof Error ? error.message : String(error)
      };
      logger.error("s3_backup.local_preparation_failed", { error: sanitizeError(error) });
    } finally {
      if (snapshot) rmSync(snapshot.directory, { recursive: true, force: true });
    }
    const successCount = results.filter((result) => result.status === "success").length;
    const failedCount = results.length - successCount;
    const status: S3BackupRunStatus = globalError
      ? "failed"
      : failedCount === 0 ? "success" : successCount === 0 ? "failed" : "partial";
    const summary = globalError
      ? `备份失败：本地准备失败（${globalError.message}）`
      : failedCount === 0
        ? `已成功同步到 ${successCount} 个备份目标`
        : successCount === 0
          ? `备份失败：${failedCount} 个目标均未成功`
          : `备份部分完成：成功 ${successCount} 个目标，失败 ${failedCount} 个目标`;
    const finishedAt = now();
    this.store.db.run(
      `UPDATE s3_backup_runs SET status = ?, finished_at = ?, result_json = ? WHERE id = ?`,
      status,
      finishedAt,
      JSON.stringify({ summary, targetResults: results, ...(globalError ? { localError: globalError } : {}) }),
      runId
    );
    this.store.audit(PLATFORM_AI_WORK_ID, "platform.s3-backup.run.completed", "platform-s3-backup", runId, {
      trigger,
      status,
      successTargets: successCount,
      failedTargets: failedCount
    });
    const row = this.store.db.get("SELECT * FROM s3_backup_runs WHERE id = ?", runId);
    return this.runView(row ?? { id: runId, status, result_json: "{}" });
  }

  private async backupTarget(
    target: StoredTarget,
    settings: Record<string, unknown>,
    snapshot: DatabaseSnapshot
  ): Promise<BackupRunTargetResult> {
    const resolved = this.resolveTarget(target);
    const prefixes = this.backupPrefixes(resolved);
    const base: BackupRunTargetResult = { targetId: resolved.id, targetName: resolved.name, status: "failed" };
    if (settings.backupImages === true) {
      try {
        base.images = await this.backupImages(resolved, prefixes);
      } catch (error) {
        return { ...base, error: this.logTargetFailure(target, "image", error) };
      }
    }
    try {
      const client = new S3Client(resolved, this.fetchImpl, this.validateOutboundUrl);
      let databaseKey = `${prefixes.database}/${snapshot.fileName}`;
      let sequence = 0;
      while (await client.headObject(databaseKey)) {
        sequence += 1;
        databaseKey = `${prefixes.database}/${formatS3BackupDbFileName(snapshot.createdAt, sequence)}`;
      }
      await client.putObject(databaseKey, await readFile(snapshot.path), "application/x-sqlite3");
      const remoteKeys = await client.listObjectKeys(prefixes.database);
      const retentionDeletes = selectS3BackupRetentionDeletes(
        remoteKeys,
        prefixes.database,
        Number(settings.retentionCount ?? 30)
      );
      let retentionDeleted = 0;
      for (const key of retentionDeletes) {
        await client.deleteObject(key);
        retentionDeleted += 1;
      }
      base.database = { key: databaseKey, retentionDeleted };
      base.status = "success";
      logger.info("s3_backup.target_succeeded", {
        target: s3BackupTargetLogFields(target),
        images: base.images,
        database: base.database
      });
      return base;
    } catch (error) {
      return { ...base, error: this.logTargetFailure(target, "database", error) };
    }
  }

  private async backupImages(target: ResolvedTarget, prefixes: BackupPrefixes): Promise<BackupRunTargetResult["images"]> {
    const result = { scanned: 0, skipped: 0, uploaded: 0 };
    const entries = await readdir(this.attachmentStorage.rootDirectory, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const parent = entry.parentPath ?? this.attachmentStorage.rootDirectory;
      const storageKey = relative(this.attachmentStorage.rootDirectory, join(parent, entry.name)).split(sep).join("/");
      if (storageKey.startsWith(".tmp/") || !attachmentStorageKeyPattern.test(storageKey)) continue;
      result.scanned += 1;
      const content = await readFile(join(parent, entry.name));
      const key = `${prefixes.images}/${storageKey}`;
      const client = new S3Client(target, this.fetchImpl, this.validateOutboundUrl);
      if (await client.headObject(key)) {
        result.skipped += 1;
        continue;
      }
      await client.putObject(key, content, contentTypeForStorageKey(storageKey));
      result.uploaded += 1;
    }
    return result;
  }

  private logTargetFailure(target: StoredTarget, stage: string, error: unknown): BackupRunTargetResult["error"] {
    const targetFields = s3BackupTargetLogFields(target);
    if (error instanceof S3BackupRequestError) {
      logger.error("s3_backup.target_request_failed", {
        target: targetFields,
        stage,
        request: { method: error.method, objectKey: error.key },
        response: {
          status: error.status,
          code: error.code,
          message: error.message,
          headers: error.headers,
          ...splitS3BackupLogText("body", error.body)
        }
      });
      return { stage, message: error.message, status: error.status, code: error.code || undefined };
    }
    logger.error("s3_backup.target_failed", {
      target: targetFields,
      stage,
      error: sanitizeError(error)
    });
    return { stage, message: error instanceof Error ? error.message : String(error) };
  }

  private resolveTarget(target: StoredTarget): ResolvedTarget {
    return {
      id: target.id,
      name: target.name,
      endpoint: target.endpoint,
      region: target.region,
      bucket: target.bucket,
      prefix: target.prefix,
      accessKey: this.vault.decrypt({
        encrypted: target.encryptedAccessKey,
        iv: target.accessKeyIv,
        tag: target.accessKeyTag
      }),
      secretKey: this.vault.decrypt({
        encrypted: target.encryptedSecretKey,
        iv: target.secretKeyIv,
        tag: target.secretKeyTag
      }),
      createdAt: target.createdAt,
      updatedAt: target.updatedAt
    };
  }

  private backupPrefixes(target: ResolvedTarget): BackupPrefixes {
    const configured = normalizeS3BackupPrefix(target.prefix);
    const root = [configured, "scriverse"].filter(Boolean).join("/");
    return { root, images: `${root}/img`, database: `${root}/db` };
  }

  private createDatabaseSnapshot(fileName: string): DatabaseSnapshot {
    const parent = this.databasePath === ":memory:"
      ? mkdtempSync(join(tmpdir(), "scriverse-s3-backup-"))
      : mkdtempSync(join(dirname(this.databasePath), ".scriverse-s3-backup-"));
    const path = join(parent, fileName);
    this.store.db.raw.prepare("VACUUM INTO ?").run(path);
    chmodSync(path, 0o600);
    return { path, directory: parent, fileName, createdAt: new Date() };
  }

  private async assertSafeTargetEndpoint(endpoint: string): Promise<void> {
    if (!this.validateOutboundUrl) return;
    try {
      await this.validateOutboundUrl(endpoint);
    } catch (error) {
      if (error instanceof AppError) {
        throw new AppError(error.status, "UNSAFE_S3_BACKUP_ENDPOINT", `S3 备份目标地址不安全：${error.message}`);
      }
      throw error;
    }
  }

  private storedTargets(): StoredTarget[] {
    return this.store.db.all("SELECT * FROM s3_backup_targets ORDER BY created_at").map((row) => this.storedTarget(row));
  }

  private storedTarget(row: Row): StoredTarget {
    return {
      id: String(row.id ?? ""),
      name: String(row.name ?? ""),
      endpoint: String(row.endpoint ?? ""),
      region: String(row.region ?? ""),
      bucket: String(row.bucket ?? ""),
      prefix: String(row.prefix ?? ""),
      enabled: Number(row.enabled) === 1,
      encryptedAccessKey: String(row.encrypted_access_key ?? ""),
      accessKeyIv: String(row.access_key_iv ?? ""),
      accessKeyTag: String(row.access_key_tag ?? ""),
      encryptedSecretKey: String(row.encrypted_secret_key ?? ""),
      secretKeyIv: String(row.secret_key_iv ?? ""),
      secretKeyTag: String(row.secret_key_tag ?? ""),
      createdAt: String(row.created_at ?? ""),
      updatedAt: String(row.updated_at ?? "")
    };
  }

  private targetView(target: StoredTarget): Record<string, unknown> {
    const accessKey = this.vault.decrypt({
      encrypted: target.encryptedAccessKey,
      iv: target.accessKeyIv,
      tag: target.accessKeyTag
    });
    return {
      id: target.id,
      name: target.name,
      endpoint: target.endpoint,
      region: target.region,
      bucket: target.bucket,
      prefix: target.prefix,
      enabled: target.enabled,
      accessKeyMasked: maskS3Credential(accessKey),
      secretKeySet: true,
      createdAt: target.createdAt,
      updatedAt: target.updatedAt
    };
  }

  getLatestRun(): Record<string, unknown> | null {
    const row = this.store.db.get("SELECT * FROM s3_backup_runs ORDER BY started_at DESC LIMIT 1");
    return row ? this.runView(row) : null;
  }

  private runView(row: Row): Record<string, unknown> {
    const result = json<Record<string, unknown>>(String(row.result_json ?? "{}"), {});
    return {
      id: String(row.id ?? ""),
      trigger: String(row.trigger ?? "manual"),
      status: String(row.status ?? "failed"),
      startedAt: String(row.started_at ?? ""),
      finishedAt: String(row.finished_at ?? "") || null,
      failureNotified: Number(row.failure_notified) === 1,
      ...result
    };
  }

  private armSchedule(): void {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = null;
    if (this.disposed) return;
    const settings = this.getSettings();
    if (settings.enabled !== true) return;
    const delay = nextBackupScheduleDelay(String(settings.scheduleTime));
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = null;
      if (this.disposed) return;
      if (this.activeRunPromise) {
        this.armSchedule();
        return;
      }
      const targets = this.storedTargets().filter((target) => target.enabled);
      if (targets.length === 0) {
        this.armSchedule();
        return;
      }
      void this.runOnce("scheduled")
        .catch((error) => logger.warn("s3_backup.scheduled_run_rejected", { error: sanitizeError(error) }))
        .finally(() => this.armSchedule());
    }, delay);
    this.scheduleTimer.unref?.();
  }
}

export function maskS3Credential(value: string): string {
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}
