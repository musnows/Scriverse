/**
 * 轻量 S3 兼容对象存储客户端。
 * 手写 AWS SigV4 签名，支持虚拟主机样式与路径样式访问（MinIO、R2、OSS 等兼容服务）。
 * 仅实现备份所需的最小接口：ListObjectsV2、PutObject、DeleteObject。
 * 网络层使用可注入的 fetch，便于测试替换。
 */
import { createHash, createHmac } from "node:crypto";
import { AppError } from "./errors.js";

export type S3ClientOptions = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetchImpl?: typeof fetch;
  /** 单次请求超时（毫秒），默认 120 秒。 */
  timeoutMs?: number;
  /** 测试用时钟，默认取当前时间。 */
  now?: () => Date;
};

export type S3ObjectSummary = {
  key: string;
  size: number;
  lastModified: string;
};

/** S3 服务端拒绝请求时抛出的错误，携带服务端返回结果以便完整记录。 */
export class S3ServiceError extends AppError {
  readonly s3Status: number;
  readonly s3Code: string;
  readonly s3Message: string;
  readonly s3RequestId: string | null;
  readonly s3BodyText: string;

  constructor(
    s3Status: number,
    s3Code: string,
    s3Message: string,
    s3RequestId: string | null = null,
    s3BodyText = ""
  ) {
    super(502, "S3_SERVICE_ERROR", `对象存储返回错误：${s3Status}（${s3Code}）${s3Message}`);
    this.s3Status = s3Status;
    this.s3Code = s3Code;
    this.s3Message = s3Message;
    this.s3RequestId = s3RequestId;
    this.s3BodyText = s3BodyText;
  }
}

function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

/** AWS SigV4 的 URI 编码规则：保留 unreserved 字符，其余百分号编码；默认保留路径分隔符。 */
export function uriEncode(value: string, encodeSlash = false): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/giu, encodeSlash ? "%2F" : "/");
}

function canonicalQueryString(query: Map<string, string>): string {
  return [...query.entries()]
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${uriEncode(key)}=${uriEncode(value, true)}`)
    .join("&");
}

function formatAmzDate(date: Date): { amzDate: string; shortDate: string } {
  const amzDate = date.toISOString().replace(/[:-]/gu, "").replace(/\.\d{3}/u, "");
  return { amzDate, shortDate: amzDate.slice(0, 8) };
}

function isLoopbackOrIp(hostname: string): boolean {
  const normalized = hostname.trim().toLocaleLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "localhost") return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(normalized) || normalized.includes(":");
}

function parseS3ErrorBody(bodyText: string): { code: string; message: string; requestId: string | null } {
  const code = /<Code>([\s\S]*?)<\/Code>/u.exec(bodyText)?.[1]?.trim();
  const message = /<Message>([\s\S]*?)<\/Message>/u.exec(bodyText)?.[1]?.trim();
  const requestId = /<RequestId>([\s\S]*?)<\/RequestId>/u.exec(bodyText)?.[1]?.trim();
  return {
    code: code ?? (bodyText ? "S3_ERROR" : "EMPTY_RESPONSE"),
    message: message ?? (bodyText ? bodyText.slice(0, 500) : "服务端返回空响应"),
    requestId: requestId || null
  };
}

export class S3CompatClient {
  private readonly endpointUrl: URL;
  private readonly bucket: string;
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly pathStyle: boolean;

  constructor(options: S3ClientOptions) {
    let url: URL;
    try {
      url = new URL(options.endpoint);
    } catch {
      throw new AppError(400, "BACKUP_ENDPOINT_INVALID", "备份端点不是有效的 HTTP(S) 地址");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new AppError(400, "BACKUP_ENDPOINT_INVALID", "备份端点仅支持 HTTP 或 HTTPS");
    }
    if (url.username || url.password) {
      throw new AppError(400, "BACKUP_ENDPOINT_INVALID", "备份端点不允许内嵌账号或密码");
    }
    if (url.search || url.hash) {
      throw new AppError(400, "BACKUP_ENDPOINT_INVALID", "备份端点不允许携带查询参数或锚点");
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,253}$/u.test(options.bucket)) {
      throw new AppError(400, "BACKUP_BUCKET_INVALID", "桶名仅允许小写字母、数字、点和短横线");
    }
    this.endpointUrl = url;
    this.bucket = options.bucket;
    this.region = options.region;
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.now = options.now ?? (() => new Date());
    this.pathStyle = isLoopbackOrIp(url.hostname) || Boolean(url.pathname && url.pathname !== "/");
  }

  private endpointBasePath(): string {
    const pathname = this.endpointUrl.pathname.replace(/\/+$/u, "");
    return pathname || "";
  }

  /** 计算对象 key 的完整访问 URL（不含查询参数）。 */
  private objectUrl(key: string): URL {
    const base = new URL(this.endpointUrl);
    if (this.pathStyle) {
      base.pathname = `${this.endpointBasePath()}/${this.bucket}/${key}`;
    } else {
      base.hostname = `${this.bucket}.${base.hostname}`;
      base.pathname = `${this.endpointBasePath()}/${key}`;
    }
    base.search = "";
    base.hash = "";
    return base;
  }

  private sign(method: string, url: URL, query: Map<string, string>, payloadHash: string): string {
    const { amzDate, shortDate } = formatAmzDate(this.now());
    const host = url.host;
    // url.pathname 已是百分号编码形式，必须解码后按 SigV4 规则重新单次规范化编码，
    // 否则含空格或非 ASCII 字符的对象 key（如用户配置的子目录）会被双重编码导致签名失败。
    const canonicalUri = uriEncode(decodeURIComponent(url.pathname));
    const canonicalQuery = canonicalQueryString(query);
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join("\n");
    const credentialScope = `${shortDate}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest)
    ].join("\n");
    const dateKey = hmac(`AWS4${this.secretAccessKey}`, shortDate);
    const regionKey = hmac(dateKey, this.region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = hmac(signingKey, stringToSign).toString("hex");
    return `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  }

  private async execute(
    method: string,
    key: string,
    options: { query?: Map<string, string>; body?: Buffer; contentType?: string } = {}
  ): Promise<Response> {
    const url = this.objectUrl(key);
    const query = options.query ?? new Map();
    // 查询参数必须同时参与签名与实际请求；使用签名时的规范化序列化保证两者一致。
    if (query.size > 0) url.search = canonicalQueryString(query);
    const payload = options.body ?? Buffer.alloc(0);
    const payloadHash = sha256Hex(payload);
    const { amzDate } = formatAmzDate(this.now());
    const authorization = this.sign(method, url, query, payloadHash);
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      authorization
    };
    if (options.contentType) headers["content-type"] = options.contentType;
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: payload.length > 0 ? new Uint8Array(payload) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      const message = error instanceof Error && error.name === "TimeoutError" || error instanceof Error && error.name === "AbortError"
        ? `请求超时（${Math.round(this.timeoutMs / 1000)} 秒）`
        : error instanceof Error ? error.message : "网络请求失败";
      throw new S3ServiceError(0, "NETWORK_ERROR", message, null, "");
    }
    if (response.status >= 200 && response.status < 300) return response;
    const bodyText = (await response.text().catch(() => "")).slice(0, 4000);
    const parsed = parseS3ErrorBody(bodyText);
    throw new S3ServiceError(response.status, parsed.code, parsed.message, parsed.requestId, bodyText);
  }

  /** 分页列出指定前缀下的全部对象。 */
  async listObjects(prefix: string): Promise<S3ObjectSummary[]> {
    const results: S3ObjectSummary[] = [];
    let continuationToken: string | null = null;
    for (let round = 0; round < 1000; round += 1) {
      const query = new Map<string, string>([
        ["list-type", "2"],
        ["prefix", prefix]
      ]);
      if (continuationToken) query.set("continuation-token", continuationToken);
      const response = await this.execute("GET", "", { query });
      const body = await response.text();
      const contentsMatches = [...body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)];
      for (const match of contentsMatches) {
        const item = match[1];
        if (!item) continue;
        const key = /<Key>([\s\S]*?)<\/Key>/u.exec(item)?.[1] ?? "";
        const size = Number(/<Size>(\d+)<\/Size>/u.exec(item)?.[1] ?? 0);
        const lastModified = /<LastModified>([\s\S]*?)<\/LastModified>/u.exec(item)?.[1] ?? "";
        if (key) results.push({ key, size, lastModified });
      }
      const isTruncated = /<IsTruncated>true<\/IsTruncated>/u.test(body);
      const nextToken = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/u.exec(body)?.[1] ?? null;
      if (!isTruncated) break;
      if (!nextToken) throw new S3ServiceError(0, "LIST_TRUNCATED", "对象列表被截断但未返回续传令牌", null, body.slice(0, 2000));
      continuationToken = nextToken;
    }
    return results;
  }

  async listAllKeys(prefix: string): Promise<Set<string>> {
    const objects = await this.listObjects(prefix);
    return new Set(objects.map((object) => object.key));
  }

  async putObject(key: string, body: Buffer, contentType = "application/octet-stream"): Promise<void> {
    await this.execute("PUT", key, { body, contentType });
  }

  async deleteObject(key: string): Promise<void> {
    await this.execute("DELETE", key);
  }
}

export const S3_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

export function contentTypeForStorageKey(key: string): string {
  for (const [extension, mimeType] of Object.entries(S3_CONTENT_TYPES)) {
    if (key.toLocaleLowerCase().endsWith(extension)) return mimeType;
  }
  return "application/octet-stream";
}
