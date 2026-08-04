/**
 * 轻量 S3 兼容客户端。
 *
 * 仅依赖 node:crypto / node:http / node:https，不引入 AWS SDK。
 * 默认 path-style URL（`http(s)://endpoint/bucket/key`），兼容 AWS S3、
 * MinIO 以及其他声明支持 SigV4 path-style 的服务。
 *
 * 模块导出的是纯函数 + 一个 {@link createS3Client} 工厂，HTTP 实现可注入，
 * 便于在单元测试中用 `http.request` 的 mock 进行签名与重试行为验证。
 */
import { createHash, createHmac } from "node:crypto";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

export type S3ClientConfig = {
  /** 不含末尾斜杠的 endpoint，例如 `https://s3.amazonaws.com` 或 `http://127.0.0.1:9000`。 */
  endpoint: string;
  /** 目标桶名。 */
  bucket: string;
  /** 区域。AWS S3 通常使用形如 `us-east-1`，其他兼容服务可填写任何稳定字符串。 */
  region: string;
  /** Access Key ID。 */
  accessKeyId: string;
  /** Secret Access Key。 */
  secretAccessKey: string;
  /** 是否使用 path-style URL，默认为 true。 */
  pathStyle?: boolean;
  /** 单次 HTTP 请求超时（毫秒），默认 30s。 */
  timeoutMs?: number;
  /** 注入以便测试，例如使用 mock http transport。 */
  fetchImpl?: S3HttpRequestFn;
};

export type S3HttpRequestFn = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: Buffer | Uint8Array | string;
  timeoutMs?: number;
}) => Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;

export type S3Object = {
  key: string;
  size: number;
  lastModified?: string;
  etag?: string;
};

export type S3PutObjectRequest = {
  key: string;
  body: Buffer | Uint8Array | string;
  contentType?: string;
  metadata?: Record<string, string>;
};

export type S3ListObjectsResult = {
  objects: S3Object[];
  isTruncated: boolean;
  nextContinuationToken?: string;
};

export class S3Error extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly resource?: string;

  constructor(options: { status: number; code: string; message: string; requestId?: string; resource?: string }) {
    super(options.message);
    this.name = "S3Error";
    this.status = options.status;
    this.code = options.code;
    if (options.requestId) this.requestId = options.requestId;
    if (options.resource) this.resource = options.resource;
  }
}

const AMZ_ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const EMPTY_PAYLOAD_HASH = "UNSIGNED-PAYLOAD";

function toBuffer(input: unknown): Buffer {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input === "string") return Buffer.from(input, "utf8");
  if (input instanceof Uint8Array) return Buffer.from(input);
  throw new Error("S3 body 必须是 Buffer / Uint8Array / string");
}

function hashPayload(body: Buffer | Uint8Array | string | undefined): string {
  if (body === undefined) return EMPTY_PAYLOAD_HASH;
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : toBuffer(body);
  return createHash("sha256").update(buf).digest("hex");
}

function trimHeaderValue(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function uriEncodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/gu, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeS3Path(path: string): string {
  // 保留 '/'
  return path.split("/").map((segment) => segment.length ? uriEncodeSegment(segment) : "").join("/");
}

function canonicalQueryString(query: URLSearchParams): string {
  const entries: Array<[string, string]> = [];
  query.forEach((value, key) => entries.push([key, value]));
  entries.sort(([aKey, aValue], [bKey, bValue]) => {
    if (aKey < bKey) return -1;
    if (aKey > bKey) return 1;
    return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
  });
  return entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function buildSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = createHmac("sha256", `AWS4${secretAccessKey}`).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update(service).digest();
  return createHmac("sha256", kService).update("aws4_request").digest();
}

function parseHeaderLines(rawHeaders: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of rawHeaders) {
    const colonIndex = line.indexOf(":");
    if (colonIndex < 0) continue;
    const name = line.slice(0, colonIndex).trim().toLocaleLowerCase();
    const value = line.slice(colonIndex + 1).trim();
    if (name) headers[name] = value;
  }
  return headers;
}

export function defaultFetchImpl(): S3HttpRequestFn {
  return (urlString, init) => new Promise((resolve, reject) => {
    const target = new URL(urlString);
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const body = init.body;
    const headers: Record<string, string> = { ...init.headers };
    const options: RequestOptions = {
      method: init.method,
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? "443" : "80"),
      path: `${target.pathname}${target.search}`,
      headers
    };
    const transportRequest = transport(options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({ status: response.statusCode ?? 0, headers: parseHeaderLines(response.rawHeaders), body });
      });
      response.on("error", reject);
    });
    transportRequest.on("error", reject);
    if (init.timeoutMs && init.timeoutMs > 0) {
      transportRequest.setTimeout(init.timeoutMs, () => {
        transportRequest.destroy(new Error(`S3 请求超时（${init.timeoutMs}ms）: ${init.method} ${urlString}`));
      });
    }
    if (body === undefined) {
      transportRequest.end();
    } else {
      transportRequest.end(toBuffer(body));
    }
  });
}

export type SignedS3Request = {
  url: string;
  headers: Record<string, string>;
  payloadHash: string;
  canonicalRequest: string;
  stringToSign: string;
};

export type SignInput = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
  method: "HEAD" | "GET" | "PUT" | "POST" | "DELETE";
  objectKey?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Buffer | Uint8Array | string;
  signingDate?: Date;
};

export function buildSignedRequest(input: SignInput): SignedS3Request {
  const endpoint = new URL(input.endpoint);
  const usePathStyle = input.pathStyle;
  const key = (input.objectKey ?? "").replace(/^\/+/u, "").replace(/\/+$/u, "");
  const keyPath = key ? encodeS3Path(key) : "";
  const canonicalResource = usePathStyle
    ? `/${[input.bucket, keyPath].filter(Boolean).join("/")}`
    : (keyPath ? `/${keyPath}` : "/");
  const requestPath = canonicalResource === "/" && usePathStyle ? `/${input.bucket}` : canonicalResource;
  const searchParams = new URLSearchParams();
  if (input.query) {
    for (const [paramKey, value] of Object.entries(input.query)) {
      if (value === undefined || value === null) continue;
      searchParams.append(paramKey, String(value));
    }
  }

  const now = input.signingDate ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  const dateStamp = amzDate.slice(0, 8);

  // virtual-hosted 模式下，若 endpoint host 已经包含 bucket 子域（例如 AWS 提供的 endpoint）
  // 则保持 host 不变以避免双写。
  const bucketInHostSubdomain = usePathStyle
    ? false
    : endpoint.host.startsWith(`${input.bucket}.`) || endpoint.host.split(".")[0] === input.bucket;
  const hostHeader = usePathStyle || bucketInHostSubdomain ? endpoint.host : `${input.bucket}.${endpoint.host}`;
  const headers: Record<string, string> = {
    host: hostHeader,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": hashPayload(input.body)
  };
  if (input.headers) {
    for (const [headerName, value] of Object.entries(input.headers)) {
      if (value === undefined || value === null) continue;
      headers[headerName.toLocaleLowerCase()] = trimHeaderValue(String(value));
    }
  }

  const sortedHeaderKeys = Object.keys(headers).map((name) => name.toLocaleLowerCase()).sort();
  const signedHeaders = sortedHeaderKeys.join(";");
  const canonicalHeaders = sortedHeaderKeys.map((name) => `${name}:${trimHeaderValue(headers[name] ?? "")}\n`).join("");

  const payloadHash = headers["x-amz-content-sha256"] ?? EMPTY_PAYLOAD_HASH;
  const canonicalRequest = [
    input.method,
    requestPath,
    canonicalQueryString(searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");
  const credentialScope = `${dateStamp}/${input.region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    AMZ_ALGORITHM,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");
  const signingKey = buildSigningKey(input.secretAccessKey, dateStamp, input.region, SERVICE);
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  headers["authorization"] = `${AMZ_ALGORITHM} Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const requestUrl = `${endpoint.protocol}//${hostHeader}${requestPath}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`;
  return { url: requestUrl, headers, payloadHash, canonicalRequest, stringToSign };
}

export function normalizeS3ClientConfig(config: S3ClientConfig): Required<S3ClientConfig> {
  const endpoint = config.endpoint.replace(/\/+$/u, "");
  const parsed = new URL(endpoint);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("S3 endpoint 必须使用 http 或 https 协议");
  }
  if (!config.bucket || /\s/u.test(config.bucket)) {
    throw new Error("S3 bucket 名称不能为空且不能包含空白字符");
  }
  if (!config.accessKeyId) throw new Error("S3 accessKeyId 不能为空");
  if (!config.secretAccessKey) throw new Error("S3 secretAccessKey 不能为空");
  if (!config.region) throw new Error("S3 region 不能为空");
  return {
    endpoint,
    bucket: config.bucket,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    pathStyle: config.pathStyle !== false,
    timeoutMs: config.timeoutMs ?? 30_000,
    fetchImpl: config.fetchImpl ?? defaultFetchImpl()
  };
}

export type S3Client = {
  headObject(key: string): Promise<{ exists: boolean; size?: number; etag?: string; contentType?: string }>;
  putObject(request: S3PutObjectRequest): Promise<{ etag?: string; versionId?: string }>;
  listObjects(options?: { prefix?: string; maxKeys?: number }): Promise<S3ListObjectsResult>;
  deleteObjects(keys: string[]): Promise<{ deleted: string[]; errors: Array<{ key: string; code?: string; message?: string }> }>;
};

function parseErrorResponse(status: number, body: Buffer, headers: Record<string, string>): S3Error {
  const text = body.toString("utf8");
  const codeMatch = text.match(/<Code>([^<]+)<\/Code>/iu);
  const messageMatch = text.match(/<Message>([^<]+)<\/Message>/iu);
  let code = codeMatch?.[1] ?? "S3_ERROR";
  let message = messageMatch?.[1] ?? text.slice(0, 2_000);
  if (!message) message = `S3 服务返回 ${status}`;
  return new S3Error({
    status,
    code,
    message,
    requestId: headers["x-amz-request-id"],
    resource: headers["x-amz-id-2"]
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

export function createS3Client(config: S3ClientConfig): S3Client {
  const normalized = normalizeS3ClientConfig(config);

  async function send(method: SignInput["method"], objectKey: string | undefined, query: Record<string, string> | undefined, headers: Record<string, string> | undefined, body: Buffer | Uint8Array | string | undefined): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const signed = buildSignedRequest({
      endpoint: normalized.endpoint,
      bucket: normalized.bucket,
      region: normalized.region,
      accessKeyId: normalized.accessKeyId,
      secretAccessKey: normalized.secretAccessKey,
      pathStyle: normalized.pathStyle,
      method,
      objectKey,
      query,
      headers,
      body
    });
    return normalized.fetchImpl(signed.url, {
      method,
      headers: signed.headers,
      body,
      timeoutMs: normalized.timeoutMs
    });
  }

  function ensureSuccess(status: number, body: Buffer, headers: Record<string, string>, expectedStatuses: number[]): void {
    if (expectedStatuses.includes(status)) return;
    throw parseErrorResponse(status, body, headers);
  }

  return {
    async headObject(key: string) {
      const response = await send("HEAD", key, undefined, undefined, undefined);
      if (response.status === 404) return { exists: false };
      if (response.status === 200) {
        return {
          exists: true,
          size: Number(response.headers["content-length"] ?? 0),
          etag: response.headers.etag,
          contentType: response.headers["content-type"]
        };
      }
      ensureSuccess(response.status, response.body, response.headers, [200, 404]);
      return { exists: false };
    },

    async putObject(request) {
      const extraHeaders: Record<string, string> = {};
      if (request.contentType) extraHeaders["content-type"] = request.contentType;
      if (request.metadata) {
        for (const [name, value] of Object.entries(request.metadata)) {
          extraHeaders[`x-amz-meta-${name.toLocaleLowerCase()}`] = value;
        }
      }
      const response = await send("PUT", request.key, undefined, extraHeaders, request.body);
      ensureSuccess(response.status, response.body, response.headers, [200]);
      return { etag: response.headers.etag, versionId: response.headers["x-amz-version-id"] };
    },

    async listObjects(options = {}) {
      const objects: S3Object[] = [];
      let continuationToken: string | undefined;
      let isTruncated = false;
      let nextContinuationToken: string | undefined;
      do {
        const loopQuery: Record<string, string> = { "list-type": "2" };
        if (options.prefix) loopQuery.prefix = options.prefix;
        if (continuationToken) loopQuery["continuation-token"] = continuationToken;
        if (options.maxKeys !== undefined) loopQuery["max-keys"] = String(Math.min(1_000, Math.max(1, options.maxKeys)));
        const response = await send("GET", undefined, loopQuery, undefined, undefined);
        ensureSuccess(response.status, response.body, response.headers, [200]);
        const text = response.body.toString("utf8");
        const keyMatches = text.match(/<Key>([^<]+)<\/Key>/giu) ?? [];
        const sizeMatches = text.match(/<Size>([^<]+)<\/Size>/giu) ?? [];
        const etagMatches = text.match(/<ETag>([^<]+)<\/ETag>/giu) ?? [];
        const lastModifiedMatches = text.match(/<LastModified>([^<]+)<\/LastModified>/giu) ?? [];
        const isTruncatedMatch = text.match(/<IsTruncated>([^<]+)<\/IsTruncated>/iu);
        const nextTokenMatch = text.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/iu);
        const count = Math.max(keyMatches.length, sizeMatches.length, etagMatches.length, lastModifiedMatches.length);
        for (let index = 0; index < count; index += 1) {
          const keyRaw = keyMatches[index]?.replace(/^<Key>|<\/Key>$/giu, "");
          if (!keyRaw) continue;
          objects.push({
            key: keyRaw,
            size: Number(sizeMatches[index]?.replace(/^<Size>|<\/Size>$/giu, "") ?? 0),
            etag: etagMatches[index]?.replace(/^<ETag>|<\/ETag>$/giu, ""),
            lastModified: lastModifiedMatches[index]?.replace(/^<LastModified>|<\/LastModified>$/giu, "")
          });
        }
        isTruncated = isTruncatedMatch?.[1] === "true";
        nextContinuationToken = nextTokenMatch?.[1];
        continuationToken = isTruncated ? nextContinuationToken : undefined;
      } while (continuationToken);

      return { objects, isTruncated, nextContinuationToken };
    },

    async deleteObjects(keys) {
      if (!keys.length) return { deleted: [], errors: [] };
      const xml = `<?xml version="1.0" encoding="UTF-8"?><Delete>${keys.map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`).join("")}</Delete>`;
      const response = await send("POST", undefined, { delete: "" }, { "content-type": "application/xml" }, xml);
      ensureSuccess(response.status, response.body, response.headers, [200]);
      const text = response.body.toString("utf8");
      const errorBlocks = [...text.matchAll(/<Error>[\s\S]*?<\/Error>/giu)];
      const erroredKeys = new Set<string>();
      const errors: Array<{ key: string; code?: string; message?: string }> = errorBlocks.map((match) => {
        const block = match[0];
        const keyMatch = block.match(/<Key>([^<]+)<\/Key>/u);
        const codeMatch = block.match(/<Code>([^<]+)<\/Code>/u);
        const messageMatch = block.match(/<Message>([^<]+)<\/Message>/u);
        const key = keyMatch?.[1] ?? "";
        if (key) erroredKeys.add(key);
        return { key, code: codeMatch?.[1], message: messageMatch?.[1] };
      });
      const deleted = keys.filter((key) => !erroredKeys.has(key));
      return { deleted, errors };
    }
  };
}
