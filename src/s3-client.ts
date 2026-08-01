import { createHash, createHmac } from "node:crypto";
import { logger, sanitizeError } from "./logger.js";

export type S3TargetConfig = {
  id?: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  subDirectory: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

export type S3PublicConfig = {
  id?: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  subDirectory: string;
  forcePathStyle: boolean;
};

export type S3ClientError = Error & {
  config?: S3PublicConfig;
  status?: number;
  responseBody?: string;
  code?: string;
};

export type S3Object = {
  key: string;
  size: number;
  lastModified?: string;
  etag?: string;
};

export type S3HeadResult = {
  exists: boolean;
  size?: number;
  lastModified?: string;
  etag?: string;
  status: number;
};

export function maskTargetConfig(config: S3TargetConfig): S3PublicConfig {
  return {
    id: config.id,
    name: config.name,
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    subDirectory: config.subDirectory,
    forcePathStyle: config.forcePathStyle
  };
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key: Uint8Array | string, value: string): Uint8Array {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function hmacSha256Hex(key: Uint8Array | string, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function iso8601Now(date: Date = new Date()): { full: string; short: string } {
  const full = date.toISOString().replace(/[-:]|\.\d{3}Z$/gu, "");
  const short = full.slice(0, 8);
  return { full, short };
}

function uriEncode(input: string, encodeSlash = true): string {
  const encoded = encodeURIComponent(input);
  let result = encoded
    .replace(/%2F/gu, encodeSlash ? "%2F" : "/")
    .replace(/[!'()*]/gu, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return result;
}

function normalizeEndpoint(endpoint: string): string {
  let e = endpoint.trim();
  if (!/^https?:\/\//iu.test(e)) e = `https://${e}`;
  e = e.replace(/\/+$/u, "");
  return e;
}

type S3RequestOptions = {
  method: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  contentType?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

type S3Response = {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  bodyBytes: Uint8Array;
};

async function s3Request(
  config: S3TargetConfig,
  options: S3RequestOptions
): Promise<S3Response> {
  const endpoint = normalizeEndpoint(config.endpoint);
  const endpointUrl = new URL(endpoint);
  const hostFromEndpoint = endpointUrl.host;
  const bucket = config.bucket;
  const region = config.region || "us-east-1";
  const path = options.path.startsWith("/") ? options.path : `/${options.path}`;
  const forcePathStyle = Boolean(config.forcePathStyle);

  let requestHost: string;
  let canonicalUri: string;

  if (forcePathStyle) {
    requestHost = hostFromEndpoint;
    canonicalUri = `/${encodeURIComponent(bucket)}${path.split("/").map((p) => uriEncode(p)).join("/")}`;
  } else {
    requestHost = `${bucket}.${hostFromEndpoint}`;
    canonicalUri = path.split("/").map((p) => uriEncode(p)).join("/");
  }
  if (!canonicalUri.startsWith("/")) canonicalUri = `/${canonicalUri}`;

  const { full: amzFull, short: amzShort } = iso8601Now();

  const method = options.method.toUpperCase();
  const body = options.body ?? "";
  const bodyBytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const payloadHash = sha256Hex(bodyBytes);

  const contentType = options.contentType ?? (
    method === "PUT" || method === "POST" ? "application/octet-stream" : ""
  );

  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
    host: requestHost,
    "x-amz-date": amzFull,
    "x-amz-content-sha256": payloadHash
  };
  if (contentType) headers["content-type"] = contentType;
  if (bodyBytes && bodyBytes.length > 0) headers["content-length"] = String(bodyBytes.length);

  const canonicalQueryEntries = new Array<[string, string]>();
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      if (v === undefined || v === null) continue;
      canonicalQueryEntries.push([uriEncode(k), uriEncode(String(v))]);
    }
  }
  canonicalQueryEntries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const canonicalQueryString = canonicalQueryEntries.map(([k, v]) => `${k}=${v}`).join("&");

  const signedHeaderNames = Object.keys(headers)
    .map((h) => h.toLocaleLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${String(headers[name] ?? "").trim().replace(/\s+/gu, " ")}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${amzShort}/${region}/s3/aws4_request`;
  const stringToSign = [
    algorithm,
    amzFull,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");

  const kDate = hmacSha256(`AWS4${config.secretAccessKey}`, amzShort);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, "s3");
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = hmacSha256Hex(kSigning, stringToSign);

  const authorization = `${algorithm} Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  headers.Authorization = authorization;

  let url: string;
  if (forcePathStyle) {
    const queryString = canonicalQueryString ? `?${canonicalQueryString}` : "";
    url = `${endpoint}${canonicalUri}${queryString}`;
  } else {
    const protocol = endpointUrl.protocol;
    const queryString = canonicalQueryString ? `?${canonicalQueryString}` : "";
    url = `${protocol}//${requestHost}${canonicalUri}${queryString}`;
  }

  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;

  const responseHeaders: Record<string, string> = {};
  let status = 0;
  let responseText = "";
  let responseBytes = new Uint8Array();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const bodyInit: BodyInit | null =
        method !== "GET" && method !== "HEAD"
          ? (bodyBytes as unknown as BodyInit) ?? null
          : null;
      const resp = await fetchFn(url, {
        method,
        headers,
        body: bodyInit,
        signal: controller.signal,
        redirect: "follow"
      });
      status = resp.status;
      resp.headers.forEach((v, k) => {
        responseHeaders[k.toLocaleLowerCase()] = v;
      });
      try {
        const buf = await resp.arrayBuffer();
        responseBytes = new Uint8Array(buf);
        responseText = new TextDecoder("utf8", { fatal: false }).decode(responseBytes);
      } catch {
        responseText = "";
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const publicCfg = maskTargetConfig(config);
    logger.error("s3.request.network_error", {
      target: publicCfg,
      method,
      url,
      error: sanitizeError(error)
    });
    const wrappedError: S3ClientError = new Error(
      `S3 请求失败 [target=${publicCfg.name}] ${method} ${path}: 网络错误或超时 - ${error instanceof Error ? error.message : String(error)}`
    ) as S3ClientError;
    wrappedError.config = publicCfg;
    wrappedError.code = "NETWORK_ERROR";
    throw wrappedError;
  }

  return { status, headers: responseHeaders, bodyText: responseText, bodyBytes: responseBytes };
}

export async function s3HeadObject(
  config: S3TargetConfig,
  key: string,
  fetchImpl?: typeof fetch
): Promise<S3HeadResult> {
  const normalizedKey = key.startsWith("/") ? key.slice(1) : key;
  try {
    const resp = await s3Request(config, {
      method: "HEAD",
      path: `/${normalizedKey}`,
      fetchImpl,
      timeoutMs: 30_000
    });
    if (resp.status === 200 || resp.status === 304) {
      return {
        exists: true,
        size: resp.headers["content-length"] ? Number(resp.headers["content-length"]) : undefined,
        lastModified: resp.headers["last-modified"],
        etag: resp.headers["etag"],
        status: resp.status
      };
    }
    if (resp.status === 404) return { exists: false, status: 404 };
    const publicCfg = maskTargetConfig(config);
    const error: S3ClientError = new Error(
      `S3 HEAD 失败 [target=${publicCfg.name}] key=${key} HTTP ${resp.status}`
    ) as S3ClientError;
    error.config = publicCfg;
    error.status = resp.status;
    error.responseBody = resp.bodyText;
    logger.error("s3.head.failed", {
      target: publicCfg,
      key,
      status: resp.status,
      response: resp.bodyText.slice(0, 2000)
    });
    throw error;
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && (error as { status: number }).status === 404) {
      return { exists: false, status: 404 };
    }
    throw error;
  }
}

export async function s3PutObject(
  config: S3TargetConfig,
  key: string,
  body: Uint8Array | string,
  contentType: string,
  fetchImpl?: typeof fetch
): Promise<void> {
  const normalizedKey = key.startsWith("/") ? key.slice(1) : key;
  const resp = await s3Request(config, {
    method: "PUT",
    path: `/${normalizedKey}`,
    body,
    contentType,
    fetchImpl,
    timeoutMs: 300_000
  });
  if (resp.status < 200 || resp.status >= 300) {
    const publicCfg = maskTargetConfig(config);
    const error: S3ClientError = new Error(
      `S3 上传失败 [target=${publicCfg.name}] key=${key} HTTP ${resp.status}`
    ) as S3ClientError;
    error.config = publicCfg;
    error.status = resp.status;
    error.responseBody = resp.bodyText;
    logger.error("s3.put.failed", {
      target: publicCfg,
      key,
      status: resp.status,
      response: resp.bodyText.slice(0, 2000)
    });
    throw error;
  }
}

export async function s3ListObjects(
  config: S3TargetConfig,
  prefix: string,
  fetchImpl?: typeof fetch
): Promise<S3Object[]> {
  const results: S3Object[] = [];
  let continuationToken: string | undefined;
  const normalizedPrefix = prefix.endsWith("/") ? prefix : prefix;
  do {
    const query: Record<string, string | undefined> = {
      "list-type": "2",
      prefix: normalizedPrefix,
      "max-keys": "1000"
    };
    if (continuationToken) query["continuation-token"] = continuationToken;
    const resp = await s3Request(config, {
      method: "GET",
      path: "/",
      query,
      fetchImpl,
      timeoutMs: 120_000
    });
    if (resp.status < 200 || resp.status >= 300) {
      const publicCfg = maskTargetConfig(config);
      const error: S3ClientError = new Error(
        `S3 ListObjects 失败 [target=${publicCfg.name}] prefix=${normalizedPrefix} HTTP ${resp.status}`
      ) as S3ClientError;
      error.config = publicCfg;
      error.status = resp.status;
      error.responseBody = resp.bodyText;
      logger.error("s3.list.failed", {
        target: publicCfg,
        prefix: normalizedPrefix,
        status: resp.status,
        response: resp.bodyText.slice(0, 2000)
      });
      throw error;
    }
    const xml = resp.bodyText;
    const matches = xml.matchAll(/<Contents>[\s\S]*?<\/Contents>/gu);
    for (const match of matches) {
      const block = match[0];
      const keyMatch = block.match(/<Key>([^<]*)<\/Key>/u);
      const sizeMatch = block.match(/<Size>([^<]*)<\/Size>/u);
      const lastModMatch = block.match(/<LastModified>([^<]*)<\/LastModified>/u);
      const etagMatch = block.match(/<ETag>([^<]*)<\/ETag>/u);
      if (!keyMatch || !keyMatch[1]) continue;
      const key = keyMatch[1];
      const size = sizeMatch && sizeMatch[1] ? Number(sizeMatch[1]) : 0;
      const obj: S3Object = { key, size };
      if (lastModMatch && lastModMatch[1]) obj.lastModified = lastModMatch[1];
      if (etagMatch && etagMatch[1]) obj.etag = etagMatch[1];
      results.push(obj);
    }
    const isTruncatedMatch = xml.match(/<IsTruncated>([^<]*)<\/IsTruncated>/u);
    const nextTokenMatch = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/u);
    if (isTruncatedMatch?.[1] === "true" && nextTokenMatch?.[1]) {
      continuationToken = nextTokenMatch[1];
    } else {
      continuationToken = undefined;
    }
  } while (continuationToken);
  return results;
}

export async function s3DeleteObject(
  config: S3TargetConfig,
  key: string,
  fetchImpl?: typeof fetch
): Promise<void> {
  const normalizedKey = key.startsWith("/") ? key.slice(1) : key;
  const resp = await s3Request(config, {
    method: "DELETE",
    path: `/${normalizedKey}`,
    fetchImpl,
    timeoutMs: 60_000
  });
  if (resp.status < 200 || resp.status >= 300) {
    const publicCfg = maskTargetConfig(config);
    const error: S3ClientError = new Error(
      `S3 删除失败 [target=${publicCfg.name}] key=${key} HTTP ${resp.status}`
    ) as S3ClientError;
    error.config = publicCfg;
    error.status = resp.status;
    error.responseBody = resp.bodyText;
    logger.error("s3.delete.failed", {
      target: publicCfg,
      key,
      status: resp.status,
      response: resp.bodyText.slice(0, 2000)
    });
    throw error;
  }
}
