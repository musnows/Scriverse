import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { AttachmentStorage } from "./attachment-storage.js";
import type { CredentialVault, EncryptedSecret } from "./credential-vault.js";
import type { Database, Row } from "./database.js";
import { PLATFORM_AI_WORK_ID } from "./database.js";
import { AppError } from "./errors.js";
import { logger, sanitizeError } from "./logger.js";
import { fetchSafeAiEndpoint } from "./security.js";
import type { Store } from "./store.js";

export type S3BackupTargetInput = {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  subdirectory?: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle?: boolean;
  enabled?: boolean;
  backupImages?: boolean;
  scheduleTime?: string;
  retentionCount?: number;
};

export type S3BackupTargetUpdate = Partial<Omit<S3BackupTargetInput, "accessKeyId" | "secretAccessKey">> & {
  accessKeyId?: string;
  secretAccessKey?: string;
};

export type S3BackupTargetPublic = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  subdirectory: string;
  accessKeyHint: string;
  pathStyle: boolean;
  enabled: boolean;
  backupImages: boolean;
  scheduleTime: string;
  retentionCount: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: "never" | "running" | "success" | "failed";
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

type S3BackupTargetSecret = S3BackupTargetPublic & {
  accessKeyId: string;
  secretAccessKey: string;
};

type S3ObjectSummary = {
  key: string;
  lastModified: string;
  size: number;
};

type S3RequestFailure = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
};

type S3BackupFailure = {
  targetId: string;
  targetName: string;
  config: Record<string, unknown>;
  message: string;
  serverResponse: S3RequestFailure | null;
};

type OutboundUrlValidator = (url: string) => Promise<readonly { address: string; family: 4 | 6 }[] | void>;

export type S3BackupTargetRunResult = {
  targetId: string;
  targetName: string;
  startedAt: string;
  completedAt: string;
  databaseKey: string;
  uploadedDatabaseCount: number;
  uploadedImageCount: number;
  skippedImageCount: number;
  missingImageCount: number;
  deletedDatabaseBackupCount: number;
};

export type S3BackupRunSummary = {
  startedAt: string;
  completedAt: string;
  targetCount: number;
  results: S3BackupTargetRunResult[];
};

class S3RequestError extends Error {
  constructor(message: string, readonly response: S3RequestFailure | null) {
    super(message);
    this.name = "S3RequestError";
  }
}

class S3BackupTargetError extends Error {
  constructor(readonly failure: S3BackupFailure, cause: unknown) {
    super(failure.message);
    this.name = "S3BackupTargetError";
    this.cause = cause;
  }
}

function now(): string {
  return new Date().toISOString();
}

function bool(row: Row, key: string): boolean {
  return Number(row[key] ?? 0) === 1;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function encrypted(row: Row, valueKey: string, ivKey: string, tagKey: string): EncryptedSecret {
  return {
    encrypted: String(row[valueKey] ?? ""),
    iv: String(row[ivKey] ?? ""),
    tag: String(row[tagKey] ?? "")
  };
}

function secretHint(secret: string): string {
  if (secret.length <= 8) return "*".repeat(secret.length);
  return `${secret.slice(0, 4)}${"*".repeat(Math.min(12, Math.max(4, secret.length - 8)))}${secret.slice(-4)}`;
}

export function normalizeS3BackupSubdirectory(value: string | undefined): string {
  const trimmed = (value ?? "").trim().replace(/^\/+|\/+$/gu, "");
  if (!trimmed) return "";
  const segments = trimmed.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new AppError(400, "INVALID_S3_BACKUP_SUBDIRECTORY", "S3 子目录不能包含 . 或 .. 片段");
  }
  return segments.join("/");
}

function normalizeEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AppError(400, "INVALID_S3_ENDPOINT", "S3 Endpoint 必须是有效 URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AppError(400, "INVALID_S3_ENDPOINT", "S3 Endpoint 仅支持 HTTP 或 HTTPS");
  }
  if (url.username || url.password) {
    throw new AppError(400, "INVALID_S3_ENDPOINT", "S3 Endpoint 不能包含用户名或密码");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/gu, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

function validateScheduleTime(value: string): string {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) {
    throw new AppError(400, "INVALID_S3_BACKUP_SCHEDULE_TIME", "备份触发时间必须是 HH:mm 格式");
  }
  return value;
}

function normalizeRetentionCount(value: number | undefined): number {
  if (value === undefined) return 30;
  return Math.min(1000, Math.max(1, Math.trunc(value)));
}

function targetBasePrefix(target: Pick<S3BackupTargetPublic, "subdirectory">): string {
  return [target.subdirectory, "scriverse"].filter(Boolean).join("/");
}

function imageExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "bin";
}

function timestampForFileName(date = new Date()): string {
  return date.toISOString().replace(/[-:.]/gu, "").replace("T", "T").replace("Z", "Z");
}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function hmac(key: Buffer | string, content: string): Buffer {
  return createHmac("sha256", key).update(content).digest();
}

function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeS3Key(key: string): string {
  return key.split("/").map(uriEncode).join("/");
}

function canonicalQuery(entries: Array<[string, string]>): string {
  return entries
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function xmlText(value: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "u").exec(value);
  return match ? decodeXmlEntities(match[1] ?? "") : "";
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function databaseBackupNamePrefix(databasePath: string): string {
  const extension = extname(databasePath);
  return (extension ? basename(databasePath, extension) : basename(databasePath)).replace(/[^A-Za-z0-9._-]/gu, "_") || "scriverse";
}

function s3LogConfig(target: S3BackupTargetSecret | S3BackupTargetPublic): Record<string, unknown> {
  return {
    id: target.id,
    name: target.name,
    endpoint: target.endpoint,
    region: target.region,
    bucket: target.bucket,
    subdirectory: target.subdirectory,
    pathStyle: target.pathStyle,
    enabled: target.enabled,
    backupImages: target.backupImages,
    scheduleTime: target.scheduleTime,
    retentionCount: target.retentionCount
  };
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => { result[key] = value; });
  return result;
}

function serverResponseForLog(response: S3RequestFailure | null): Record<string, unknown> | null {
  if (!response) return null;
  const bodyChunks = response.body.match(/[\s\S]{1,3500}/gu) ?? [];
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: response.body,
    bodyChunks
  };
}

class S3Client {
  constructor(
    private readonly target: S3BackupTargetSecret,
    private readonly fetchImpl: typeof fetch,
    private readonly validateOutboundUrl?: OutboundUrlValidator
  ) {}

  async headObject(key: string): Promise<boolean> {
    const response = await this.request("HEAD", key, [], undefined, undefined, new Set([404]));
    return response.status !== 404;
  }

  async putObject(key: string, content: Buffer, contentType: string): Promise<void> {
    await this.request("PUT", key, [], content, contentType);
  }

  async deleteObject(key: string): Promise<void> {
    await this.request("DELETE", key);
  }

  async listObjects(prefix: string): Promise<S3ObjectSummary[]> {
    const objects: S3ObjectSummary[] = [];
    let continuationToken = "";
    do {
      const query: Array<[string, string]> = [["list-type", "2"], ["prefix", prefix], ["max-keys", "1000"]];
      if (continuationToken) query.push(["continuation-token", continuationToken]);
      const response = await this.request("GET", "", query);
      const body = await response.text();
      const matches = [...body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)];
      for (const match of matches) {
        const entry = match[1] ?? "";
        const key = xmlText(entry, "Key");
        if (!key) continue;
        objects.push({
          key,
          lastModified: xmlText(entry, "LastModified"),
          size: Number(xmlText(entry, "Size")) || 0
        });
      }
      continuationToken = /<IsTruncated>\s*true\s*<\/IsTruncated>/iu.test(body)
        ? xmlText(body, "NextContinuationToken")
        : "";
    } while (continuationToken);
    return objects;
  }

  private targetUrl(key: string, query: Array<[string, string]>): { url: URL; canonicalUri: string; canonicalQuery: string } {
    const endpoint = new URL(this.target.endpoint);
    const basePath = endpoint.pathname.replace(/\/+$/gu, "");
    const encodedKey = key ? encodeS3Key(key) : "";
    let path: string;
    if (this.target.pathStyle) {
      path = `${basePath}/${uriEncode(this.target.bucket)}${encodedKey ? `/${encodedKey}` : ""}`;
    } else {
      endpoint.hostname = `${this.target.bucket}.${endpoint.hostname}`;
      path = `${basePath || ""}${encodedKey ? `/${encodedKey}` : "/"}`;
    }
    endpoint.pathname = path.replace(/\/{2,}/gu, "/");
    const queryText = canonicalQuery(query);
    endpoint.search = queryText;
    return { url: endpoint, canonicalUri: endpoint.pathname || "/", canonicalQuery: queryText };
  }

  private async request(
    method: "GET" | "HEAD" | "PUT" | "DELETE",
    key = "",
    query: Array<[string, string]> = [],
    body?: Buffer,
    contentType?: string,
    acceptedStatuses = new Set<number>()
  ): Promise<Response> {
    const payload = body ?? Buffer.alloc(0);
    const payloadHash = sha256Hex(payload);
    const requestDate = new Date();
    const amzDate = requestDate.toISOString().replace(/[:-]|\.\d{3}/gu, "");
    const dateStamp = amzDate.slice(0, 8);
    const { url, canonicalUri, canonicalQuery: queryText } = this.targetUrl(key, query);
    const headers = new Headers();
    headers.set("host", url.host);
    headers.set("x-amz-date", amzDate);
    headers.set("x-amz-content-sha256", payloadHash);
    if (contentType) headers.set("content-type", contentType);
    const headerEntries = Object.entries(headersToRecord(headers))
      .map(([name, value]) => [name.toLocaleLowerCase(), value.trim().replace(/\s+/gu, " ")] as const)
      .sort(([left], [right]) => left.localeCompare(right));
    const canonicalHeaders = headerEntries.map(([name, value]) => `${name}:${value}\n`).join("");
    const signedHeaders = headerEntries.map(([name]) => name).join(";");
    const credentialScope = `${dateStamp}/${this.target.region}/s3/aws4_request`;
    const canonicalRequest = [
      method,
      canonicalUri,
      queryText,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(Buffer.from(canonicalRequest, "utf8"))
    ].join("\n");
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.target.secretAccessKey}`, dateStamp), this.target.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    headers.set(
      "authorization",
      `AWS4-HMAC-SHA256 Credential=${this.target.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    );

    let response: Response;
    const requestInit: RequestInit = {
      method,
      headers,
      ...(body ? { body: new Uint8Array(body) } : {})
    };
    try {
      response = this.validateOutboundUrl
        ? await fetchSafeAiEndpoint(this.fetchImpl, url.toString(), requestInit, this.validateOutboundUrl)
        : await this.fetchImpl(url, requestInit);
    } catch (error) {
      throw new S3RequestError(error instanceof Error ? error.message : "S3 request failed", null);
    }
    if (!response.ok && !acceptedStatuses.has(response.status)) {
      const responseBody = method === "HEAD" ? "" : await response.text().catch(() => "");
      throw new S3RequestError(`S3 request failed with HTTP ${response.status}`, {
        status: response.status,
        statusText: response.statusText,
        headers: headersToRecord(response.headers),
        body: responseBody
      });
    }
    return response;
  }
}

export class S3BackupManager {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly runningTargets = new Set<string>();
  private schedulerStarted = false;

  constructor(
    private readonly database: Database,
    private readonly store: Store,
    private readonly vault: CredentialVault,
    private readonly attachmentStorage: AttachmentStorage,
    private readonly databasePath: string,
    private readonly fetchImpl: typeof fetch,
    private readonly validateOutboundUrl?: OutboundUrlValidator
  ) {}

  startScheduler(): void {
    this.schedulerStarted = true;
    this.refreshSchedules();
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.schedulerStarted = false;
  }

  listTargets(): S3BackupTargetPublic[] {
    return this.database.all("SELECT * FROM s3_backup_targets ORDER BY created_at, name").map((row) => this.mapPublicTarget(row));
  }

  getTarget(targetId: string): S3BackupTargetPublic {
    return this.mapPublicTarget(this.requireTargetRow(targetId));
  }

  createTarget(input: S3BackupTargetInput): S3BackupTargetPublic {
    const targetId = `s3_backup_${randomUUID()}`;
    const timestamp = now();
    const accessKey = this.vault.encrypt(input.accessKeyId.trim());
    const secretKey = this.vault.encrypt(input.secretAccessKey);
    const target = {
      name: input.name.trim(),
      endpoint: normalizeEndpoint(input.endpoint),
      region: input.region.trim() || "us-east-1",
      bucket: input.bucket.trim(),
      subdirectory: normalizeS3BackupSubdirectory(input.subdirectory),
      pathStyle: input.pathStyle ?? true,
      enabled: input.enabled ?? false,
      backupImages: input.backupImages ?? true,
      scheduleTime: validateScheduleTime(input.scheduleTime ?? "03:00"),
      retentionCount: normalizeRetentionCount(input.retentionCount)
    };
    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO s3_backup_targets (
          id, name, endpoint, region, bucket, subdirectory, access_key_hint,
          encrypted_access_key_id, access_key_iv, access_key_tag,
          encrypted_secret_access_key, secret_key_iv, secret_key_tag,
          path_style, enabled, backup_images, schedule_time, retention_count,
          last_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'never', ?, ?)`,
        targetId,
        target.name,
        target.endpoint,
        target.region,
        target.bucket,
        target.subdirectory,
        secretHint(input.accessKeyId.trim()),
        accessKey.encrypted,
        accessKey.iv,
        accessKey.tag,
        secretKey.encrypted,
        secretKey.iv,
        secretKey.tag,
        target.pathStyle ? 1 : 0,
        target.enabled ? 1 : 0,
        target.backupImages ? 1 : 0,
        target.scheduleTime,
        target.retentionCount,
        timestamp,
        timestamp
      );
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.s3-backup-target.created", "s3-backup-target", targetId, s3LogConfig({ id: targetId, ...target } as S3BackupTargetPublic));
    });
    this.refreshSchedules();
    return this.getTarget(targetId);
  }

  updateTarget(targetId: string, input: S3BackupTargetUpdate): S3BackupTargetPublic {
    const current = this.requireTargetRow(targetId);
    const timestamp = now();
    const accessKey = input.accessKeyId !== undefined && input.accessKeyId.trim()
      ? this.vault.encrypt(input.accessKeyId.trim())
      : null;
    const secretKey = input.secretAccessKey !== undefined && input.secretAccessKey
      ? this.vault.encrypt(input.secretAccessKey)
      : null;
    const next = {
      name: input.name === undefined ? String(current.name) : input.name.trim(),
      endpoint: input.endpoint === undefined ? String(current.endpoint) : normalizeEndpoint(input.endpoint),
      region: input.region === undefined ? String(current.region) : input.region.trim() || "us-east-1",
      bucket: input.bucket === undefined ? String(current.bucket) : input.bucket.trim(),
      subdirectory: input.subdirectory === undefined ? String(current.subdirectory ?? "") : normalizeS3BackupSubdirectory(input.subdirectory),
      pathStyle: input.pathStyle === undefined ? bool(current, "path_style") : input.pathStyle,
      enabled: input.enabled === undefined ? bool(current, "enabled") : input.enabled,
      backupImages: input.backupImages === undefined ? bool(current, "backup_images") : input.backupImages,
      scheduleTime: input.scheduleTime === undefined ? String(current.schedule_time) : validateScheduleTime(input.scheduleTime),
      retentionCount: input.retentionCount === undefined ? Number(current.retention_count) : normalizeRetentionCount(input.retentionCount)
    };
    this.database.transaction(() => {
      this.database.run(
        `UPDATE s3_backup_targets SET
          name = ?, endpoint = ?, region = ?, bucket = ?, subdirectory = ?,
          access_key_hint = ?, encrypted_access_key_id = ?, access_key_iv = ?, access_key_tag = ?,
          encrypted_secret_access_key = ?, secret_key_iv = ?, secret_key_tag = ?,
          path_style = ?, enabled = ?, backup_images = ?, schedule_time = ?, retention_count = ?,
          updated_at = ?
         WHERE id = ?`,
        next.name,
        next.endpoint,
        next.region,
        next.bucket,
        next.subdirectory,
        accessKey ? secretHint(input.accessKeyId!.trim()) : String(current.access_key_hint ?? ""),
        accessKey?.encrypted ?? String(current.encrypted_access_key_id),
        accessKey?.iv ?? String(current.access_key_iv),
        accessKey?.tag ?? String(current.access_key_tag),
        secretKey?.encrypted ?? String(current.encrypted_secret_access_key),
        secretKey?.iv ?? String(current.secret_key_iv),
        secretKey?.tag ?? String(current.secret_key_tag),
        next.pathStyle ? 1 : 0,
        next.enabled ? 1 : 0,
        next.backupImages ? 1 : 0,
        next.scheduleTime,
        next.retentionCount,
        timestamp,
        targetId
      );
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.s3-backup-target.updated", "s3-backup-target", targetId, s3LogConfig({ id: targetId, ...next } as S3BackupTargetPublic));
    });
    this.refreshSchedules();
    return this.getTarget(targetId);
  }

  deleteTarget(targetId: string): void {
    const target = this.getTarget(targetId);
    this.database.transaction(() => {
      this.database.run("DELETE FROM s3_backup_targets WHERE id = ?", targetId);
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.s3-backup-target.deleted", "s3-backup-target", targetId, s3LogConfig(target));
    });
    this.refreshSchedules();
  }

  async runEnabledTargets(source: "manual" | "scheduled" = "manual"): Promise<S3BackupRunSummary> {
    const startedAt = now();
    const rows = this.database.all("SELECT * FROM s3_backup_targets WHERE enabled = 1 ORDER BY created_at, name");
    const results: S3BackupTargetRunResult[] = [];
    const failures: S3BackupFailure[] = [];
    for (const row of rows) {
      try {
        results.push(await this.runTargetRow(row, source));
      } catch (error) {
        failures.push(error instanceof S3BackupTargetError ? error.failure : this.failureFromUnknown(this.decryptTarget(row), error));
      }
    }
    if (failures.length > 0) {
      throw new AppError(502, "S3_BACKUP_FAILED", `${failures.length} 个 S3 备份目标同步失败`, { failures });
    }
    return { startedAt, completedAt: now(), targetCount: rows.length, results };
  }

  async runTarget(targetId: string, source: "manual" | "scheduled" = "manual"): Promise<S3BackupTargetRunResult> {
    try {
      return await this.runTargetRow(this.requireTargetRow(targetId), source);
    } catch (error) {
      if (error instanceof S3BackupTargetError) {
        throw new AppError(502, "S3_BACKUP_FAILED", "S3 备份目标同步失败", { failures: [error.failure] });
      }
      throw error;
    }
  }

  private refreshSchedules(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (!this.schedulerStarted) return;
    for (const target of this.listTargets().filter((item) => item.enabled)) {
      this.scheduleTarget(target);
    }
  }

  private scheduleTarget(target: S3BackupTargetPublic): void {
    const delay = this.delayUntilNextRun(target.scheduleTime);
    const timer = setTimeout(() => {
      this.timers.delete(target.id);
      void this.runTarget(target.id, "scheduled")
        .catch((error) => {
          logger.error("s3_backup.scheduled_run.failed", { target: s3LogConfig(target), error: sanitizeError(error) });
        })
        .finally(() => {
          const latest = this.database.get("SELECT * FROM s3_backup_targets WHERE id = ? AND enabled = 1", target.id);
          if (latest && this.schedulerStarted) this.scheduleTarget(this.mapPublicTarget(latest));
        });
    }, delay);
    timer.unref();
    this.timers.set(target.id, timer);
    logger.info("s3_backup.target_scheduled", { target: s3LogConfig(target), delayMs: delay });
  }

  private delayUntilNextRun(scheduleTime: string): number {
    const [hourText, minuteText] = scheduleTime.split(":");
    const next = new Date();
    next.setHours(Number(hourText), Number(minuteText), 0, 0);
    const current = Date.now();
    if (next.getTime() <= current) next.setDate(next.getDate() + 1);
    return Math.max(1000, next.getTime() - current);
  }

  private async runTargetRow(row: Row, source: "manual" | "scheduled"): Promise<S3BackupTargetRunResult> {
    const target = this.decryptTarget(row);
    if (this.runningTargets.has(target.id)) {
      throw new AppError(409, "S3_BACKUP_TARGET_RUNNING", "该 S3 备份目标正在同步中");
    }
    this.runningTargets.add(target.id);
    const startedAt = now();
    this.database.run("UPDATE s3_backup_targets SET last_status = 'running', last_run_at = ?, last_error = NULL, updated_at = ? WHERE id = ?", startedAt, startedAt, target.id);
    try {
      const result = await this.performBackup(target, startedAt);
      const completedAt = now();
      this.database.run(
        "UPDATE s3_backup_targets SET last_status = 'success', last_success_at = ?, last_error = NULL, updated_at = ? WHERE id = ?",
        completedAt,
        completedAt,
        target.id
      );
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.s3-backup.completed", "s3-backup-target", target.id, {
        source,
        ...result
      });
      logger.info("s3_backup.target_completed", { target: s3LogConfig(target), source, result });
      return { ...result, completedAt };
    } catch (error) {
      const failure = this.failureFromUnknown(target, error);
      const timestamp = now();
      this.database.run(
        "UPDATE s3_backup_targets SET last_status = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
        failure.message.slice(0, 2000),
        timestamp,
        target.id
      );
      logger.error("s3_backup.target_failed", {
        target: s3LogConfig(target),
        serverResponse: serverResponseForLog(failure.serverResponse),
        error: sanitizeError(error)
      });
      throw new S3BackupTargetError(failure, error);
    } finally {
      this.runningTargets.delete(target.id);
    }
  }

  private async performBackup(target: S3BackupTargetSecret, startedAt: string): Promise<Omit<S3BackupTargetRunResult, "completedAt">> {
    const client = new S3Client(target, this.fetchImpl, this.validateOutboundUrl);
    const basePrefix = targetBasePrefix(target);
    const dbPrefix = `${basePrefix}/db/`;
    const imgPrefix = `${basePrefix}/img/`;
    const dbNamePrefix = databaseBackupNamePrefix(this.databasePath);
    const databaseKey = `${dbPrefix}${dbNamePrefix}-${timestampForFileName(new Date(startedAt))}.db`;
    const snapshot = this.databaseSnapshot();
    await client.putObject(databaseKey, snapshot, "application/vnd.sqlite3");

    let uploadedImageCount = 0;
    let skippedImageCount = 0;
    let missingImageCount = 0;
    if (target.backupImages) {
      for (const image of this.listImageSources()) {
        if (image.missing) {
          missingImageCount += 1;
          logger.warn("s3_backup.image_missing", { target: s3LogConfig(target), imageKey: image.key });
          continue;
        }
        const key = `${imgPrefix}${image.key}`;
        if (await client.headObject(key)) {
          skippedImageCount += 1;
          continue;
        }
        await client.putObject(key, image.content, image.mimeType);
        uploadedImageCount += 1;
      }
    }
    const deletedDatabaseBackupCount = await this.enforceRetention(client, dbPrefix, dbNamePrefix, target.retentionCount);
    return {
      targetId: target.id,
      targetName: target.name,
      startedAt,
      databaseKey,
      uploadedDatabaseCount: 1,
      uploadedImageCount,
      skippedImageCount,
      missingImageCount,
      deletedDatabaseBackupCount
    };
  }

  private databaseSnapshot(): Buffer {
    if (this.databasePath === ":memory:") {
      throw new AppError(400, "DATABASE_BACKUP_UNAVAILABLE", "内存数据库无法创建 S3 备份");
    }
    this.database.raw.exec("PRAGMA wal_checkpoint(FULL)");
    if (!existsSync(this.databasePath)) throw new AppError(500, "DATABASE_FILE_NOT_FOUND", "数据库文件不存在，无法创建备份");
    return readFileSync(this.databasePath);
  }

  private listImageSources(): Array<{ key: string; mimeType: string; content: Buffer; missing: boolean }> {
    const sources: Array<{ key: string; mimeType: string; content: Buffer; missing: boolean }> = [];
    const attachmentRows = this.database.all("SELECT DISTINCT storage_key, stored_mime_type FROM attachments ORDER BY storage_key");
    for (const row of attachmentRows) {
      const storageKey = String(row.storage_key ?? "");
      const mimeType = String(row.stored_mime_type ?? "application/octet-stream");
      let path: string;
      try {
        path = this.attachmentStorage.path(storageKey);
      } catch {
        sources.push({ key: `attachments/${storageKey}`, mimeType, content: Buffer.alloc(0), missing: true });
        continue;
      }
      sources.push(existsSync(path)
        ? { key: `attachments/${storageKey}`, mimeType, content: readFileSync(path), missing: false }
        : { key: `attachments/${storageKey}`, mimeType, content: Buffer.alloc(0), missing: true });
    }
    for (const row of this.database.all("SELECT work_id, mime_type, content, sha256 FROM work_covers ORDER BY work_id")) {
      const mimeType = String(row.mime_type ?? "application/octet-stream");
      const sha = String(row.sha256 ?? sha256Hex(Buffer.from(row.content as Uint8Array)));
      sources.push({
        key: `work-covers/${String(row.work_id)}-${sha}.${imageExtension(mimeType)}`,
        mimeType,
        content: Buffer.from(row.content as Uint8Array),
        missing: false
      });
    }
    for (const row of this.database.all("SELECT user_id, mime_type, content, sha256 FROM user_avatars ORDER BY user_id")) {
      const mimeType = String(row.mime_type ?? "application/octet-stream");
      const sha = String(row.sha256 ?? sha256Hex(Buffer.from(row.content as Uint8Array)));
      sources.push({
        key: `user-avatars/${String(row.user_id)}-${sha}.${imageExtension(mimeType)}`,
        mimeType,
        content: Buffer.from(row.content as Uint8Array),
        missing: false
      });
    }
    return sources;
  }

  private async enforceRetention(client: S3Client, dbPrefix: string, dbNamePrefix: string, retentionCount: number): Promise<number> {
    const objects = (await client.listObjects(dbPrefix))
      .filter((object) => {
        const name = object.key.slice(dbPrefix.length);
        return object.key.startsWith(dbPrefix) && name.startsWith(`${dbNamePrefix}-`) && name.endsWith(".db");
      })
      .sort((left, right) => {
        const leftTime = Date.parse(left.lastModified);
        const rightTime = Date.parse(right.lastModified);
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
        return left.key.localeCompare(right.key);
      });
    const obsolete = objects.slice(0, Math.max(0, objects.length - retentionCount));
    for (const object of obsolete) await client.deleteObject(object.key);
    return obsolete.length;
  }

  private failureFromUnknown(target: S3BackupTargetSecret, error: unknown): S3BackupFailure {
    const message = error instanceof Error ? error.message : "S3 backup failed";
    return {
      targetId: target.id,
      targetName: target.name,
      config: s3LogConfig(target),
      message,
      serverResponse: error instanceof S3RequestError ? error.response : null
    };
  }

  private requireTargetRow(targetId: string): Row {
    const row = this.database.get("SELECT * FROM s3_backup_targets WHERE id = ?", targetId);
    if (!row) throw new AppError(404, "S3_BACKUP_TARGET_NOT_FOUND", "S3 备份目标不存在");
    return row;
  }

  private mapPublicTarget(row: Row): S3BackupTargetPublic {
    const status = String(row.last_status ?? "never");
    return {
      id: String(row.id),
      name: String(row.name),
      endpoint: String(row.endpoint),
      region: String(row.region),
      bucket: String(row.bucket),
      subdirectory: String(row.subdirectory ?? ""),
      accessKeyHint: String(row.access_key_hint ?? ""),
      pathStyle: bool(row, "path_style"),
      enabled: bool(row, "enabled"),
      backupImages: bool(row, "backup_images"),
      scheduleTime: String(row.schedule_time ?? "03:00"),
      retentionCount: Number(row.retention_count ?? 30),
      lastRunAt: nullableString(row.last_run_at),
      lastSuccessAt: nullableString(row.last_success_at),
      lastStatus: status === "running" || status === "success" || status === "failed" ? status : "never",
      lastError: nullableString(row.last_error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private decryptTarget(row: Row): S3BackupTargetSecret {
    return {
      ...this.mapPublicTarget(row),
      accessKeyId: this.vault.decrypt(encrypted(row, "encrypted_access_key_id", "access_key_iv", "access_key_tag")),
      secretAccessKey: this.vault.decrypt(encrypted(row, "encrypted_secret_access_key", "secret_key_iv", "secret_key_tag"))
    };
  }
}
