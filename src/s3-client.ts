import { createHash, createHmac } from "node:crypto";
import { AppError } from "./errors.js";

/** 备份对象在桶内的固定根目录名。 */
export const BACKUP_ROOT_SEGMENT = "scriverse";
export const BACKUP_DATABASE_SEGMENT = "db";
export const BACKUP_IMAGE_SEGMENT = "img";

const emptyPayloadSha256 = createHash("sha256").update("").digest("hex");
const maximumPrefixLength = 512;
const maximumPrefixSegmentLength = 128;
const maximumResponseBodyLength = 4_000;
const maximumListPages = 200;

export type S3TargetDescriptor = {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
};

export type S3Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
};

export type S3ObjectSummary = {
  key: string;
  size: number;
  lastModified: string;
};

export type S3FailureDetail = {
  operation: string;
  method: string;
  requestUrl: string;
  objectKey: string;
  httpStatus: number | null;
  s3Code: string;
  s3Message: string;
  s3RequestId: string;
  responseBody: string;
};

export class S3RequestError extends Error {
  constructor(message: string, readonly detail: S3FailureDetail) {
    super(message);
    this.name = "S3RequestError";
  }
}

/**
 * AWS SigV4 要求对未保留字符之外的字节做百分号编码；对象路径中的 `/` 必须保留。
 */
export function uriEncodeComponent(value: string, encodeSlash = true): string {
  let result = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const character = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/u.test(character)) result += character;
    else if (character === "/" && !encodeSlash) result += character;
    else result += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return result;
}

/** 把用户填写的子目录规范化为不含首尾斜杠、无路径穿越的对象前缀。 */
export function normalizeBackupPrefix(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.includes("\\")) throw new AppError(400, "INVALID_BACKUP_PREFIX", "备份子目录不能包含反斜杠");
  if (/[\u0000-\u001f\u007f]/u.test(raw)) throw new AppError(400, "INVALID_BACKUP_PREFIX", "备份子目录不能包含控制字符");
  const segments = raw.split("/").filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment === "." || segment === "..") throw new AppError(400, "INVALID_BACKUP_PREFIX", "备份子目录不能包含相对路径片段");
    if (segment.length > maximumPrefixSegmentLength) {
      throw new AppError(400, "INVALID_BACKUP_PREFIX", `备份子目录的单层名称不能超过 ${maximumPrefixSegmentLength} 个字符`);
    }
  }
  const normalized = segments.join("/");
  if (normalized.length > maximumPrefixLength) {
    throw new AppError(400, "INVALID_BACKUP_PREFIX", `备份子目录不能超过 ${maximumPrefixLength} 个字符`);
  }
  return normalized;
}

/** 拼接对象键：`{子目录}/scriverse/{...}`，未配置子目录时落在桶根目录。 */
export function buildBackupObjectKey(prefix: string, ...segments: string[]): string {
  return [normalizeBackupPrefix(prefix), BACKUP_ROOT_SEGMENT, ...segments]
    .flatMap((segment) => String(segment).split("/"))
    .filter((segment) => segment.length > 0)
    .join("/");
}

export function backupDatabasePrefix(prefix: string): string {
  return `${buildBackupObjectKey(prefix, BACKUP_DATABASE_SEGMENT)}/`;
}

export function backupImagePrefix(prefix: string): string {
  return `${buildBackupObjectKey(prefix, BACKUP_IMAGE_SEGMENT)}/`;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/gu, "&");
}

function readXmlTag(body: string, tag: string): string {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "u").exec(body);
  return match?.[1] === undefined ? "" : decodeXmlText(match[1]).trim();
}

/** 解析 S3 错误响应体；非 XML 或空响应时返回空字段，由调用方回退到 HTTP 状态。 */
export function parseS3ErrorPayload(body: string): { code: string; message: string; requestId: string } {
  return {
    code: readXmlTag(body, "Code"),
    message: readXmlTag(body, "Message"),
    requestId: readXmlTag(body, "RequestId")
  };
}

export function parseListObjectsPayload(body: string): {
  objects: S3ObjectSummary[];
  nextContinuationToken: string;
  truncated: boolean;
} {
  const objects: S3ObjectSummary[] = [];
  for (const match of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)) {
    const entry = match[1] ?? "";
    const key = readXmlTag(entry, "Key");
    if (!key) continue;
    objects.push({
      key,
      size: Number(readXmlTag(entry, "Size") || 0),
      lastModified: readXmlTag(entry, "LastModified")
    });
  }
  return {
    objects,
    nextContinuationToken: readXmlTag(body, "NextContinuationToken"),
    truncated: readXmlTag(body, "IsTruncated").toLocaleLowerCase() === "true"
  };
}

export function formatAmazonDateTime(date: Date): string {
  return `${date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "")}Z`;
}

function deriveSigningKey(secretAccessKey: string, date: string, region: string, service: string): Buffer {
  const dateKey = createHmac("sha256", `AWS4${secretAccessKey}`).update(date).digest();
  const regionKey = createHmac("sha256", dateKey).update(region).digest();
  const serviceKey = createHmac("sha256", regionKey).update(service).digest();
  return createHmac("sha256", serviceKey).update("aws4_request").digest();
}

export type SignedRequestInput = {
  method: string;
  canonicalUri: string;
  /** 已按键名排序的查询参数。 */
  query: Array<[string, string]>;
  host: string;
  payloadSha256: string;
  amazonDateTime: string;
  region: string;
  service?: string;
  credentials: S3Credentials;
  additionalHeaders?: Record<string, string>;
};

/** 按 AWS Signature Version 4 生成请求头，包含 Authorization。 */
export function signAwsV4Request(input: SignedRequestInput): Record<string, string> {
  const service = input.service ?? "s3";
  const date = input.amazonDateTime.slice(0, 8);
  const headers: Record<string, string> = {
    host: input.host,
    "x-amz-content-sha256": input.payloadSha256,
    "x-amz-date": input.amazonDateTime,
    ...Object.fromEntries(Object.entries(input.additionalHeaders ?? {}).map(([key, value]) => [key.toLocaleLowerCase(), value]))
  };
  const sortedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/gu, " ")}\n`)
    .join("");
  const signedHeaders = sortedHeaderNames.join(";");
  const canonicalQueryString = [...input.query]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${uriEncodeComponent(key)}=${uriEncodeComponent(value)}`)
    .join("&");
  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    input.payloadSha256
  ].join("\n");
  const credentialScope = `${date}/${input.region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amazonDateTime,
    credentialScope,
    createHash("sha256").update(canonicalRequest).digest("hex")
  ].join("\n");
  const signature = createHmac("sha256", deriveSigningKey(input.credentials.secretAccessKey, date, input.region, service))
    .update(stringToSign)
    .digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
}

export type S3RequestSender = (url: string, init: RequestInit) => Promise<Response>;

type S3RequestOptions = {
  operation: string;
  method: "GET" | "PUT" | "HEAD" | "DELETE";
  objectKey?: string;
  query?: Array<[string, string]>;
  body?: Buffer;
  contentType?: string;
  timeoutMs: number;
  acceptStatuses?: number[];
};

type S3Response = {
  status: number;
  body: string;
};

export class S3Client {
  constructor(
    private readonly target: S3TargetDescriptor,
    private readonly credentials: S3Credentials,
    private readonly send: S3RequestSender,
    private readonly now: () => Date = () => new Date()
  ) {}

  private resolveRequestUrl(objectKey: string, query: Array<[string, string]>): { url: string; host: string; canonicalUri: string } {
    const endpoint = new URL(this.target.endpoint);
    const basePath = endpoint.pathname.replace(/\/+$/u, "");
    const encodedKey = objectKey ? uriEncodeComponent(objectKey, false) : "";
    const host = this.target.forcePathStyle ? endpoint.host : `${this.target.bucket}.${endpoint.host}`;
    const pathSegments = this.target.forcePathStyle
      ? [basePath, uriEncodeComponent(this.target.bucket), encodedKey]
      : [basePath, encodedKey];
    const canonicalUri = `/${pathSegments.filter((segment) => segment.length > 0).join("/").replace(/^\/+/u, "")}`;
    const search = query.length
      ? `?${[...query]
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, value]) => `${uriEncodeComponent(key)}=${uriEncodeComponent(value)}`)
        .join("&")}`
      : "";
    return { url: `${endpoint.protocol}//${host}${canonicalUri}${search}`, host, canonicalUri };
  }

  private async request(options: S3RequestOptions): Promise<S3Response> {
    const objectKey = options.objectKey ?? "";
    const query = options.query ?? [];
    const { url, host, canonicalUri } = this.resolveRequestUrl(objectKey, query);
    const payloadSha256 = options.body
      ? createHash("sha256").update(options.body).digest("hex")
      : emptyPayloadSha256;
    const headers = signAwsV4Request({
      method: options.method,
      canonicalUri,
      query,
      host,
      payloadSha256,
      amazonDateTime: formatAmazonDateTime(this.now()),
      region: this.target.region,
      credentials: this.credentials,
      // 不携带 content-length：undici 在自定义 dispatcher 下会拒绝手工设置的该请求头，
      // 由 HTTP 层按请求体自动补齐即可，AWS SigV4 也不要求签名这个头。
      additionalHeaders: options.body ? { "content-type": options.contentType ?? "application/octet-stream" } : {}
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`S3 请求超时（${Math.round(options.timeoutMs / 1_000)} 秒）`)), options.timeoutMs);
    let response: Response;
    try {
      response = await this.send(url, {
        method: options.method,
        headers,
        ...(options.body ? { body: new Uint8Array(options.body) } : {}),
        signal: controller.signal
      });
    } catch (error) {
      throw new S3RequestError(error instanceof Error ? error.message : "S3 请求失败", {
        operation: options.operation,
        method: options.method,
        requestUrl: url,
        objectKey,
        httpStatus: null,
        s3Code: "NETWORK_ERROR",
        s3Message: error instanceof Error ? error.message : String(error),
        s3RequestId: "",
        responseBody: ""
      });
    } finally {
      clearTimeout(timeout);
    }
    const body = options.method === "HEAD" ? "" : (await response.text().catch(() => "")).slice(0, maximumResponseBodyLength);
    const accepted = options.acceptStatuses ?? [];
    if (!response.ok && !accepted.includes(response.status)) {
      const parsed = parseS3ErrorPayload(body);
      throw new S3RequestError(
        `S3 ${options.operation} 失败：HTTP ${response.status}${parsed.code ? ` ${parsed.code}` : ""}${parsed.message ? ` ${parsed.message}` : ""}`,
        {
          operation: options.operation,
          method: options.method,
          requestUrl: url,
          objectKey,
          httpStatus: response.status,
          s3Code: parsed.code || `HTTP_${response.status}`,
          s3Message: parsed.message || response.statusText,
          s3RequestId: parsed.requestId || response.headers.get("x-amz-request-id") || "",
          responseBody: body
        }
      );
    }
    return { status: response.status, body };
  }

  async putObject(objectKey: string, body: Buffer, contentType = "application/octet-stream", timeoutMs = 600_000): Promise<void> {
    await this.request({ operation: "PutObject", method: "PUT", objectKey, body, contentType, timeoutMs });
  }

  async deleteObject(objectKey: string, timeoutMs = 30_000): Promise<void> {
    await this.request({ operation: "DeleteObject", method: "DELETE", objectKey, timeoutMs, acceptStatuses: [404] });
  }

  async listObjects(prefix: string, timeoutMs = 60_000): Promise<S3ObjectSummary[]> {
    const objects: S3ObjectSummary[] = [];
    let continuationToken = "";
    for (let page = 0; page < maximumListPages; page += 1) {
      const response = await this.request({
        operation: "ListObjectsV2",
        method: "GET",
        query: [
          ["list-type", "2"],
          ["prefix", prefix],
          ["max-keys", "1000"],
          ...(continuationToken ? [["continuation-token", continuationToken] as [string, string]] : [])
        ],
        timeoutMs
      });
      const parsed = parseListObjectsPayload(response.body);
      objects.push(...parsed.objects);
      if (!parsed.truncated || !parsed.nextContinuationToken) return objects;
      continuationToken = parsed.nextContinuationToken;
    }
    return objects;
  }

  /** 连通性探测：列举备份根目录，验证地址、凭据、区域和桶权限是否可用。 */
  async probe(): Promise<void> {
    await this.request({
      operation: "ListObjectsV2",
      method: "GET",
      query: [["list-type", "2"], ["prefix", `${buildBackupObjectKey(this.target.prefix)}/`], ["max-keys", "1"]],
      timeoutMs: 20_000
    });
  }
}
