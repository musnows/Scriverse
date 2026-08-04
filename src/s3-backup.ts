import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { AttachmentStorage } from "./attachment-storage.js";
import { CredentialVault } from "./credential-vault.js";
import { Database, PLATFORM_AI_WORK_ID } from "./database.js";
import { AppError } from "./errors.js";
import { logger, sanitizeError } from "./logger.js";
import { assertSafeS3Endpoint, fetchSafeS3Endpoint } from "./security.js";
import { Store, type S3BackupTargetForSync } from "./store.js";

type S3QueryParameter = readonly [string, string];

type S3RequestOptions = {
  body?: Buffer;
  contentType?: string;
  query?: readonly S3QueryParameter[];
};

type S3Object = {
  key: string;
};

export type S3BackupRunResult = {
  targetId: string;
  targetName: string;
  status: "success" | "failed";
  databaseObjectKey?: string;
  imageCount?: number;
  skippedImageCount?: number;
  deletedDatabaseCount?: number;
  message?: string;
};

export class S3BackupRunError extends Error {
  constructor(readonly results: S3BackupRunResult[]) {
    super("至少一个 S3 备份目标同步失败");
    this.name = "S3BackupRunError";
  }
}

class S3RequestError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
    readonly statusText: string,
    readonly responseHeaders: Record<string, string>,
    readonly responseBody: string
  ) {
    super(`S3 请求失败：${method} ${url}（HTTP ${status}${statusText ? ` ${statusText}` : ""}）`);
    this.name = "S3RequestError";
  }
}

export type S3BackupManagerOptions = {
  database: Database;
  store: Store;
  attachmentStorage: AttachmentStorage;
  credentialVault: CredentialVault;
  fetchImpl: typeof fetch;
  allowPrivateS3Endpoints?: boolean;
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function sign(key: Buffer | string, date: string, region: string, service: string, value: string): string {
  const dateKey = hmac(`AWS4${key}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(hmac(serviceKey, "aws4_request"), value).toString("hex");
}

function encodeS3Component(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`);
}

function canonicalQuery(parameters: readonly S3QueryParameter[]): string {
  return parameters
    .map(([key, value]) => [encodeS3Component(key), encodeS3Component(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
      if (leftValue === rightValue) return 0;
      return leftValue < rightValue ? -1 : 1;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function dateParts(value: Date): { date: string; timestamp: string } {
  const iso = value.toISOString();
  return {
    date: iso.slice(0, 10).replace(/-/gu, ""),
    timestamp: `${iso.slice(0, 19).replace(/[-:]/gu, "")}Z`
  };
}

function databaseTimestamp(value: Date): string {
  const iso = value.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}${iso.slice(20, 23)}Z`;
}

function normalizeSubdirectory(value: string): string {
  return value.split("/").map((part) => part.trim()).filter(Boolean).join("/");
}

function s3Root(target: Pick<S3BackupTargetForSync, "subdirectory">): string {
  const subdirectory = normalizeSubdirectory(target.subdirectory);
  return subdirectory ? `${subdirectory}/scriverse` : "scriverse";
}

function imageContentType(storageKey: string): string {
  if (storageKey.endsWith(".png")) return "image/png";
  if (storageKey.endsWith(".jpg") || storageKey.endsWith(".jpeg")) return "image/jpeg";
  if (storageKey.endsWith(".gif")) return "image/gif";
  return "image/webp";
}

function decodeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/giu, (entity) => {
    if (entity === "&amp;") return "&";
    if (entity === "&lt;") return "<";
    if (entity === "&gt;") return ">";
    if (entity === "&quot;") return '"';
    if (entity === "&apos;") return "'";
    const numeric = entity.slice(2, -1);
    const codePoint = numeric.startsWith("x") || numeric.startsWith("X")
      ? Number.parseInt(numeric.slice(1), 16)
      : Number.parseInt(numeric, 10);
    return Number.isInteger(codePoint) && codePoint >= 0 ? String.fromCodePoint(codePoint) : entity;
  });
}

function responseHeaders(response: Response): Record<string, string> {
  const entries: Array<[string, string]> = [];
  response.headers.forEach((value, name) => entries.push([name, value]));
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function localMinuteSlot(value = new Date()): { time: string; slot: string } {
  const two = (part: number): string => String(part).padStart(2, "0");
  return {
    time: `${two(value.getHours())}:${two(value.getMinutes())}`,
    slot: `${value.getFullYear()}-${two(value.getMonth() + 1)}-${two(value.getDate())}T${two(value.getHours())}:${two(value.getMinutes())}`
  };
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}

class SignedS3Client {
  private readonly endpoint: URL;
  private readonly validateEndpoint: ((url: string) => Promise<unknown>) | undefined;

  constructor(
    private readonly target: S3BackupTargetForSync,
    private readonly accessKeyId: string,
    private readonly secretAccessKey: string,
    private readonly fetchImpl: typeof fetch,
    allowPrivateS3Endpoints: boolean | undefined
  ) {
    this.endpoint = new URL(target.endpoint);
    this.endpoint.pathname = this.endpoint.pathname.replace(/\/+$/gu, "") || "/";
    this.validateEndpoint = allowPrivateS3Endpoints === undefined
      ? undefined
      : async (url) => assertSafeS3Endpoint(url, allowPrivateS3Endpoints);
  }

  private objectUrl(key: string, query: readonly S3QueryParameter[] = []): URL {
    const url = new URL(this.endpoint.toString());
    const basePath = this.endpoint.pathname === "/" ? "" : this.endpoint.pathname.replace(/\/+$/gu, "");
    const bucket = encodeS3Component(this.target.bucket);
    const objectPath = key.split("/").filter(Boolean).map(encodeS3Component).join("/");
    url.pathname = `${basePath}/${bucket}${objectPath ? `/${objectPath}` : ""}`;
    const queryString = canonicalQuery(query);
    url.search = queryString ? `?${queryString}` : "";
    url.hash = "";
    return url;
  }

  private async request(method: string, key: string, options: S3RequestOptions = {}): Promise<Response> {
    const query = options.query ?? [];
    const url = this.objectUrl(key, query);
    const now = new Date();
    const { date, timestamp } = dateParts(now);
    const body = options.body ?? Buffer.alloc(0);
    const payloadHash = sha256(body);
    const signingHeaders: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": timestamp
    };
    if (options.contentType) signingHeaders["content-type"] = options.contentType;
    const canonicalHeaderNames = Object.keys(signingHeaders).sort();
    const canonicalHeaders = canonicalHeaderNames
      .map((name) => `${name}:${(signingHeaders[name] ?? "").trim().replace(/\s+/gu, " ")}\n`)
      .join("");
    const signedHeaders = canonicalHeaderNames.join(";");
    const scope = `${date}/${this.target.region}/s3/aws4_request`;
    const canonicalRequest = [
      method,
      url.pathname,
      canonicalQuery(query),
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256(canonicalRequest)].join("\n");
    const signature = sign(this.secretAccessKey, date, this.target.region, "s3", stringToSign);
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const headers: Record<string, string> = {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": timestamp,
      authorization
    };
    if (options.contentType) headers["content-type"] = options.contentType;
    return await fetchSafeS3Endpoint(this.fetchImpl, url.toString(), {
      method,
      headers,
      ...(options.body ? { body: options.body as unknown as RequestInit["body"] } : {})
    }, this.validateEndpoint as ((url: string) => Promise<readonly { address: string; family: 4 | 6 }[] | void>) | undefined);
  }

  private async assertSuccessful(response: Response, method: string, key: string): Promise<void> {
    if (response.ok) return;
    const body = await response.text().catch(() => "");
    throw new S3RequestError(method, this.objectUrl(key).toString(), response.status, response.statusText, responseHeaders(response), body);
  }

  async objectExists(key: string): Promise<boolean> {
    const response = await this.request("HEAD", key);
    if (response.ok) return true;
    if (response.status === 404) return false;
    await this.assertSuccessful(response, "HEAD", key);
    return false;
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    const response = await this.request("PUT", key, { body, contentType });
    await this.assertSuccessful(response, "PUT", key);
  }

  async deleteObject(key: string): Promise<void> {
    const response = await this.request("DELETE", key);
    await this.assertSuccessful(response, "DELETE", key);
  }

  async listObjects(prefix: string): Promise<S3Object[]> {
    const objects: S3Object[] = [];
    let continuationToken: string | null = null;
    for (let page = 0; page < 1_000; page += 1) {
      const query: S3QueryParameter[] = [["list-type", "2"], ["prefix", prefix]];
      if (continuationToken) query.push(["continuation-token", continuationToken]);
      const response = await this.request("GET", "", { query });
      await this.assertSuccessful(response, "GET", "");
      const body = await response.text();
      for (const match of body.matchAll(/<Contents\b[^>]*>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<\/Contents>/giu)) {
        objects.push({ key: decodeXml(match[1] ?? "") });
      }
      const isTruncated = /<IsTruncated>true<\/IsTruncated>/iu.test(body);
      const nextToken = body.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/iu)?.[1];
      if (!isTruncated) return objects;
      if (!nextToken) throw new Error("S3 列表响应缺少续页令牌");
      continuationToken = decodeXml(nextToken);
    }
    throw new Error("S3 列表分页超过安全上限");
  }
}

export class S3BackupManager {
  private readonly database: Database;
  private readonly store: Store;
  private readonly attachmentStorage: AttachmentStorage;
  private readonly credentialVault: CredentialVault;
  private readonly fetchImpl: typeof fetch;
  private readonly allowPrivateS3Endpoints: boolean | undefined;
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;
  private scheduleCheckRunning = false;
  private executionChain: Promise<void> = Promise.resolve();

  constructor(options: S3BackupManagerOptions) {
    this.database = options.database;
    this.store = options.store;
    this.attachmentStorage = options.attachmentStorage;
    this.credentialVault = options.credentialVault;
    this.fetchImpl = options.fetchImpl;
    this.allowPrivateS3Endpoints = options.allowPrivateS3Endpoints;
  }

  start(): void {
    if (this.scheduleTimer) return;
    this.scheduleTimer = setInterval(() => {
      void this.runDueBackups();
    }, 30_000);
    this.scheduleTimer.unref();
    void this.runDueBackups();
  }

  dispose(): void {
    if (!this.scheduleTimer) return;
    clearInterval(this.scheduleTimer);
    this.scheduleTimer = null;
  }

  async runAll(targetId?: string): Promise<S3BackupRunResult[]> {
    const results = await this.enqueue(async () => {
      const targets = targetId
        ? [this.store.getS3BackupTargetForSync(targetId)]
        : this.store.listS3BackupTargetsForSync(true);
      return await this.runTargets(targets);
    });
    if (results.some((result) => result.status === "failed")) throw new S3BackupRunError(results);
    return results;
  }

  async runDueBackups(): Promise<void> {
    if (this.scheduleCheckRunning) return;
    this.scheduleCheckRunning = true;
    try {
      const minute = localMinuteSlot();
      const dueTargets = this.store.listS3BackupTargetsForSync(true).filter((target) => target.scheduleTime === minute.time);
      const reservedTargets = dueTargets.filter((target) => this.store.reserveS3BackupScheduleSlot(target.id, minute.slot));
      if (!reservedTargets.length) return;
      await this.enqueue(() => this.runTargets(reservedTargets));
    } catch (error) {
      logger.error("s3_backup.scheduler.failed", { error: sanitizeError(error) });
    } finally {
      this.scheduleCheckRunning = false;
    }
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.executionChain.then(operation, operation);
    this.executionChain = run.then(() => undefined, () => undefined);
    return await run;
  }

  private async runTargets(targets: S3BackupTargetForSync[]): Promise<S3BackupRunResult[]> {
    const results: S3BackupRunResult[] = [];
    for (const target of targets) {
      try {
        results.push(await this.syncTarget(target));
      } catch (error) {
        const message = this.failureSummary(error);
        const failedAt = new Date().toISOString();
        this.store.recordS3BackupFailed(target.id, failedAt, message);
        this.store.audit(PLATFORM_AI_WORK_ID, "platform.s3-backup.failed", "s3-backup", target.id, {
          targetName: target.name,
          message,
          failedAt
        });
        this.logTargetFailure(target, error);
        results.push({ targetId: target.id, targetName: target.name, status: "failed", message });
      }
    }
    return results;
  }

  private async syncTarget(target: S3BackupTargetForSync): Promise<S3BackupRunResult> {
    this.store.recordS3BackupStarted(target.id, new Date().toISOString());
    const accessKeyId = this.credentialVault.decrypt(target.accessKey);
    const secretAccessKey = this.credentialVault.decrypt(target.secretAccessKey);
    const client = new SignedS3Client(target, accessKeyId, secretAccessKey, this.fetchImpl, this.allowPrivateS3Endpoints);
    let snapshotPath: string | null = null;
    try {
      const snapshot = await this.createDatabaseSnapshot();
      snapshotPath = snapshot.path;
      let imageCount = 0;
      let skippedImageCount = 0;
      if (target.backupImages) {
        const images = await this.syncImages(client, target);
        imageCount = images.uploaded;
        skippedImageCount = images.skipped;
      }
      const databaseObjectKey = `${s3Root(target)}/db/${snapshot.fileName}`;
      await client.putObject(databaseObjectKey, await readFile(snapshot.path), "application/vnd.sqlite3");
      const deletedDatabaseCount = await this.pruneDatabaseSnapshots(client, target, databaseObjectKey);
      const finishedAt = new Date().toISOString();
      this.store.recordS3BackupSucceeded(target.id, finishedAt);
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.s3-backup.succeeded", "s3-backup", target.id, {
        targetName: target.name,
        databaseObjectKey,
        imageCount,
        skippedImageCount,
        deletedDatabaseCount,
        finishedAt
      });
      logger.info("s3_backup.target.succeeded", {
        target: this.loggableTarget(target),
        databaseObjectKey,
        imageCount,
        skippedImageCount,
        deletedDatabaseCount
      });
      return { targetId: target.id, targetName: target.name, status: "success", databaseObjectKey, imageCount, skippedImageCount, deletedDatabaseCount };
    } finally {
      if (snapshotPath) await unlink(snapshotPath).catch(() => undefined);
    }
  }

  private async createDatabaseSnapshot(): Promise<{ path: string; fileName: string }> {
    const directory = join(this.attachmentStorage.temporaryDirectory, "s3-backup-snapshots");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const fileName = `scriverse-db-${databaseTimestamp(new Date())}-${randomUUID()}.sqlite`;
    const path = join(directory, fileName);
    this.database.raw.prepare("VACUUM INTO ?").run(path);
    return { path, fileName };
  }

  private async syncImages(client: SignedS3Client, target: S3BackupTargetForSync): Promise<{ uploaded: number; skipped: number }> {
    let uploaded = 0;
    let skipped = 0;
    for (const storageKey of await this.attachmentStorageKeys()) {
      const objectKey = `${s3Root(target)}/img/${storageKey}`;
      if (await client.objectExists(objectKey)) {
        skipped += 1;
        continue;
      }
      let content: Buffer;
      try {
        content = await readFile(this.attachmentStorage.path(storageKey));
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      await client.putObject(objectKey, content, imageContentType(storageKey));
      uploaded += 1;
    }
    return { uploaded, skipped };
  }

  private async attachmentStorageKeys(directory = this.attachmentStorage.rootDirectory, prefix = ""): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const keys: string[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".tmp" || entry.name.startsWith(".")) continue;
      const storageKey = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        keys.push(...await this.attachmentStorageKeys(join(directory, entry.name), storageKey));
        continue;
      }
      if (entry.isFile() && /^[a-f0-9]{2}\/[a-f0-9]{64}\.(?:webp|png|jpe?g|gif)$/u.test(storageKey)) keys.push(storageKey);
    }
    return keys;
  }

  private async pruneDatabaseSnapshots(client: SignedS3Client, target: S3BackupTargetForSync, currentObjectKey: string): Promise<number> {
    const prefix = `${s3Root(target)}/db/`;
    const filePattern = /^scriverse-db-\d{8}T\d{6}(?:\d{3})?Z-[a-f0-9-]{36}\.sqlite$/u;
    const snapshots = (await client.listObjects(prefix))
      .filter((object) => object.key.startsWith(prefix) && filePattern.test(object.key.slice(prefix.length)))
      .sort((left, right) => left.key.localeCompare(right.key));
    const stale = snapshots
      .filter((snapshot) => snapshot.key !== currentObjectKey)
      .slice(0, Math.max(0, snapshots.length - target.retentionCount));
    let deleted = 0;
    for (const snapshot of stale) {
      await client.deleteObject(snapshot.key);
      deleted += 1;
    }
    return deleted;
  }

  private failureSummary(error: unknown): string {
    if (error instanceof S3RequestError) return `S3 请求失败（HTTP ${error.status}）`;
    if (error instanceof AppError) return error.message;
    return "S3 备份执行失败，请查看服务日志";
  }

  private loggableTarget(target: S3BackupTargetForSync): Record<string, unknown> {
    return {
      id: target.id,
      name: target.name,
      enabled: target.enabled,
      endpoint: target.endpoint,
      region: target.region,
      bucket: target.bucket,
      subdirectory: target.subdirectory,
      backupImages: target.backupImages,
      scheduleTime: target.scheduleTime,
      retentionCount: target.retentionCount
    };
  }

  private logTargetFailure(target: S3BackupTargetForSync, error: unknown): void {
    logger.error("s3_backup.target.failed", {
      target: this.loggableTarget(target),
      error: sanitizeError(error),
      ...(error instanceof S3RequestError ? {
        s3Method: error.method,
        s3RequestUrl: error.url,
        s3Status: error.status,
        s3StatusText: error.statusText,
        s3ResponseHeaders: error.responseHeaders,
        s3ServerResponseBody: error.responseBody
      } : {})
    });
  }
}
