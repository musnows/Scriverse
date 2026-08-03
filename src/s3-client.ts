import { createHash, createHmac } from "node:crypto";
import { AppError } from "./errors.js";
import { logger } from "./logger.js";

export type S3ClientConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 默认 true：路径风格，兼容 MinIO 等 S3 兼容服务 */
  forcePathStyle?: boolean;
};

export type S3ObjectSummary = {
  key: string;
  lastModified: string | null;
  size: number;
};

export type S3RequestFailureContext = {
  targetId?: string;
  name?: string;
  endpoint: string;
  region: string;
  bucket: string;
  pathPrefix?: string;
  enabled?: boolean;
  forcePathStyle?: boolean;
};

type SignedRequest = {
  url: string;
  headers: Record<string, string>;
};

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeS3Key(key: string): string {
  return key.split("/").map((segment) => encodeRfc3986(segment)).join("/");
}

function amzDate(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function normalizeEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new AppError(400, "INVALID_S3_ENDPOINT", "S3 服务地址必须是无内嵌凭据的 HTTP 或 HTTPS 地址");
  }
  return url;
}

function buildObjectUrl(config: S3ClientConfig, key: string, query = ""): { url: URL; canonicalUri: string; host: string } {
  const endpoint = normalizeEndpoint(config.endpoint);
  const forcePathStyle = config.forcePathStyle !== false;
  const encodedKey = encodeS3Key(key.replace(/^\/+/u, ""));
  let canonicalUri: string;
  let url: URL;
  if (forcePathStyle) {
    canonicalUri = `/${encodeRfc3986(config.bucket)}${encodedKey ? `/${encodedKey}` : ""}`;
    url = new URL(canonicalUri, endpoint);
  } else {
    canonicalUri = `/${encodedKey}`;
    url = new URL(canonicalUri, `${endpoint.protocol}//${config.bucket}.${endpoint.host}${endpoint.pathname.replace(/\/$/u, "")}/`);
  }
  if (query) url.search = query.startsWith("?") ? query.slice(1) : query;
  return { url, canonicalUri, host: url.host };
}

function signRequest(
  config: S3ClientConfig,
  method: string,
  key: string,
  options: {
    query?: string;
    headers?: Record<string, string>;
    payloadHash: string;
    now?: Date;
  }
): SignedRequest {
  const now = options.now ?? new Date();
  const { amzDate: amzDateValue, dateStamp } = amzDate(now);
  const { url, canonicalUri, host } = buildObjectUrl(config, key, options.query);
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": options.payloadHash,
    "x-amz-date": amzDateValue,
    ...(options.headers ?? {})
  };
  const signedHeaderNames = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const canonicalHeaders = `${signedHeaderNames.map((name) => `${name}:${headers[name]!.trim()}`).join("\n")}\n`;
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalQuery = [...url.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey === rightKey
      ? leftValue.localeCompare(rightValue)
      : leftKey.localeCompare(rightKey))
    .map(([queryKey, queryValue]) => `${encodeRfc3986(queryKey)}=${encodeRfc3986(queryValue)}`)
    .join("&");
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    options.payloadHash
  ].join("\n");
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDateValue,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), "s3"),
    "aws4_request"
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: url.toString(), headers };
}

async function readBodyLimited(response: Response, limit = 4_000): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, limit);
}

export function publicS3Config(context: S3RequestFailureContext): Record<string, unknown> {
  return {
    targetId: context.targetId,
    name: context.name,
    endpoint: context.endpoint,
    region: context.region,
    bucket: context.bucket,
    pathPrefix: context.pathPrefix ?? "",
    enabled: context.enabled,
    forcePathStyle: context.forcePathStyle !== false
  };
}

export async function s3Request(
  fetchImpl: typeof fetch,
  config: S3ClientConfig,
  method: string,
  key: string,
  options: {
    query?: string;
    headers?: Record<string, string>;
    body?: Buffer | string | null;
    failureContext: S3RequestFailureContext;
  }
): Promise<Response> {
  const payload = options.body ?? "";
  const payloadHash = sha256Hex(typeof payload === "string" ? payload : payload);
  const signed = signRequest(config, method, key, {
    query: options.query,
    headers: options.headers,
    payloadHash
  });
  let response: Response;
  try {
    let requestBody: BodyInit | undefined;
    if (method !== "GET" && method !== "HEAD") {
      requestBody = typeof payload === "string" ? payload : Uint8Array.from(payload);
    }
    response = await fetchImpl(signed.url, {
      method,
      headers: signed.headers,
      body: requestBody
    });
  } catch (error) {
    const publicConfig = publicS3Config(options.failureContext);
    logger.error("backup.s3.request_failed", {
      ...publicConfig,
      method,
      objectKey: key,
      error: error instanceof Error ? error.message : String(error)
    });
    throw new AppError(
      502,
      "S3_REQUEST_FAILED",
      `S3 请求失败：${options.failureContext.name ?? options.failureContext.bucket}（${method} ${key || "/"}）网络错误`,
      { ...publicConfig, method, objectKey: key }
    );
  }
  if (!response.ok && response.status !== 404) {
    const responseBody = await readBodyLimited(response);
    const publicConfig = publicS3Config(options.failureContext);
    logger.error("backup.s3.request_failed", {
      ...publicConfig,
      method,
      objectKey: key,
      status: response.status,
      statusText: response.statusText,
      responseBody
    });
    throw new AppError(
      502,
      "S3_REQUEST_FAILED",
      `S3 请求失败：${options.failureContext.name ?? options.failureContext.bucket} 返回 HTTP ${response.status}`,
      {
        ...publicConfig,
        method,
        objectKey: key,
        status: response.status,
        statusText: response.statusText,
        responseBody
      }
    );
  }
  return response;
}

export async function s3HeadObject(
  fetchImpl: typeof fetch,
  config: S3ClientConfig,
  key: string,
  failureContext: S3RequestFailureContext
): Promise<boolean> {
  const response = await s3Request(fetchImpl, config, "HEAD", key, { failureContext });
  if (response.status === 404) return false;
  if (!response.ok) {
    const responseBody = await readBodyLimited(response);
    const publicConfig = publicS3Config(failureContext);
    logger.error("backup.s3.request_failed", {
      ...publicConfig,
      method: "HEAD",
      objectKey: key,
      status: response.status,
      statusText: response.statusText,
      responseBody
    });
    throw new AppError(
      502,
      "S3_REQUEST_FAILED",
      `S3 请求失败：${failureContext.name ?? failureContext.bucket} 返回 HTTP ${response.status}`,
      { ...publicConfig, method: "HEAD", objectKey: key, status: response.status, responseBody }
    );
  }
  return true;
}

export async function s3PutObject(
  fetchImpl: typeof fetch,
  config: S3ClientConfig,
  key: string,
  body: Buffer,
  contentType: string,
  failureContext: S3RequestFailureContext
): Promise<void> {
  const response = await s3Request(fetchImpl, config, "PUT", key, {
    headers: {
      "content-type": contentType
    },
    body,
    failureContext
  });
  if (!response.ok) {
    const responseBody = await readBodyLimited(response);
    const publicConfig = publicS3Config(failureContext);
    logger.error("backup.s3.request_failed", {
      ...publicConfig,
      method: "PUT",
      objectKey: key,
      status: response.status,
      statusText: response.statusText,
      responseBody
    });
    throw new AppError(
      502,
      "S3_REQUEST_FAILED",
      `S3 上传失败：${failureContext.name ?? failureContext.bucket} 返回 HTTP ${response.status}`,
      { ...publicConfig, method: "PUT", objectKey: key, status: response.status, responseBody }
    );
  }
}

export async function s3DeleteObject(
  fetchImpl: typeof fetch,
  config: S3ClientConfig,
  key: string,
  failureContext: S3RequestFailureContext
): Promise<void> {
  const response = await s3Request(fetchImpl, config, "DELETE", key, { failureContext });
  if (!response.ok && response.status !== 404) {
    const responseBody = await readBodyLimited(response);
    const publicConfig = publicS3Config(failureContext);
    logger.error("backup.s3.request_failed", {
      ...publicConfig,
      method: "DELETE",
      objectKey: key,
      status: response.status,
      statusText: response.statusText,
      responseBody
    });
    throw new AppError(
      502,
      "S3_REQUEST_FAILED",
      `S3 删除失败：${failureContext.name ?? failureContext.bucket} 返回 HTTP ${response.status}`,
      { ...publicConfig, method: "DELETE", objectKey: key, status: response.status, responseBody }
    );
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

export function parseS3ListObjectsXml(xml: string): { objects: S3ObjectSummary[]; truncated: boolean; nextToken: string | null } {
  const objects: S3ObjectSummary[] = [];
  const contents = xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu);
  for (const match of contents) {
    const block = match[1] ?? "";
    const key = block.match(/<Key>([\s\S]*?)<\/Key>/u)?.[1];
    if (!key) continue;
    const lastModified = block.match(/<LastModified>([\s\S]*?)<\/LastModified>/u)?.[1] ?? null;
    const size = Number(block.match(/<Size>([\s\S]*?)<\/Size>/u)?.[1] ?? 0);
    objects.push({
      key: decodeXmlEntities(key),
      lastModified: lastModified ? decodeXmlEntities(lastModified) : null,
      size: Number.isFinite(size) ? size : 0
    });
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/iu.test(xml);
  const nextTokenRaw = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/u)?.[1] ?? null;
  return {
    objects,
    truncated,
    nextToken: nextTokenRaw ? decodeXmlEntities(nextTokenRaw) : null
  };
}

export async function s3ListObjects(
  fetchImpl: typeof fetch,
  config: S3ClientConfig,
  prefix: string,
  failureContext: S3RequestFailureContext
): Promise<S3ObjectSummary[]> {
  const objects: S3ObjectSummary[] = [];
  let continuationToken: string | null = null;
  do {
    const params = new URLSearchParams({
      "list-type": "2",
      prefix,
      "max-keys": "1000"
    });
    if (continuationToken) params.set("continuation-token", continuationToken);
    const response = await s3Request(fetchImpl, config, "GET", "", {
      query: params.toString(),
      failureContext
    });
    if (!response.ok) {
      const responseBody = await readBodyLimited(response);
      const publicConfig = publicS3Config(failureContext);
      logger.error("backup.s3.request_failed", {
        ...publicConfig,
        method: "GET",
        objectKey: "",
        prefix,
        status: response.status,
        statusText: response.statusText,
        responseBody
      });
      throw new AppError(
        502,
        "S3_REQUEST_FAILED",
        `S3 列举失败：${failureContext.name ?? failureContext.bucket} 返回 HTTP ${response.status}`,
        { ...publicConfig, method: "GET", prefix, status: response.status, responseBody }
      );
    }
    const xml = await response.text();
    const page = parseS3ListObjectsXml(xml);
    objects.push(...page.objects);
    continuationToken = page.truncated ? page.nextToken : null;
  } while (continuationToken);
  return objects;
}

export async function s3TestConnection(
  fetchImpl: typeof fetch,
  config: S3ClientConfig,
  failureContext: S3RequestFailureContext
): Promise<void> {
  const response = await s3Request(fetchImpl, config, "GET", "", {
    query: "list-type=2&max-keys=1",
    failureContext
  });
  if (!response.ok) {
    const responseBody = await readBodyLimited(response);
    const publicConfig = publicS3Config(failureContext);
    logger.error("backup.s3.request_failed", {
      ...publicConfig,
      method: "GET",
      objectKey: "",
      status: response.status,
      statusText: response.statusText,
      responseBody
    });
    throw new AppError(
      502,
      "S3_REQUEST_FAILED",
      `S3 连接测试失败：${failureContext.name ?? failureContext.bucket} 返回 HTTP ${response.status}`,
      { ...publicConfig, method: "GET", status: response.status, responseBody }
    );
  }
}

export function buildScriverseObjectKey(pathPrefix: string, category: "db" | "img", relativePath: string): string {
  const prefix = pathPrefix.trim().replace(/^\/+|\/+$/gu, "").replace(/\/{2,}/gu, "/");
  const relative = relativePath.replace(/^\/+/u, "");
  return [prefix || null, "scriverse", category, relative].filter((part): part is string => Boolean(part)).join("/");
}

export function formatBackupTimestamp(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}
