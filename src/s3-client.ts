import { createHash, createHmac } from "node:crypto";
import { AppError } from "./errors.js";
import { fetchSafeAiEndpoint, type SafeAiEndpointValidator } from "./security.js";

/** SigV4 单次签名所需的全部输入。 */
export interface SigV4SigningInput {
  method: string;
  /** 已编码的路径，如 "/bucket/scriverse/db/a.db"。 */
  canonicalUri: string;
  /** 已按键名排序并编码的查询串（不含 ?），可为空串。 */
  canonicalQuery: string;
  /** 参与签名的头（小写名），至少包含 host 和 x-amz-date。 */
  headers: Array<[string, string]>;
  /** 请求正文的 sha256 hex，空正文为 e3b0c442...b855。 */
  payloadHashHex: string;
  region: string;
  /** 服务名，S3 为 "s3"。 */
  service: string;
  secretAccessKey: string;
  /** UTC 时间，格式 "YYYYMMDDTHHMMSSZ"。 */
  amzDate: string;
  /** UTC 日期，格式 "YYYYMMDD"。 */
  dateStamp: string;
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

const compareByName = (a: readonly [string, string], b: readonly [string, string]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/** 按 AWS SigV4 规范计算签名，返回小写 hex。 */
export function sigV4Signature(input: SigV4SigningInput): string {
  const sortedHeaders = [...input.headers].sort(compareByName);
  // 头值按规范去除首尾空白并把连续空白压缩为单个空格。
  const canonicalHeaders = sortedHeaders
    .map(([name, value]) => `${name}:${value.trim().replace(/\s+/gu, " ")}\n`)
    .join("");
  const signedHeaders = sortedHeaders.map(([name]) => name).join(";");
  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    input.canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHashHex
  ].join("\n");
  const credentialScope = `${input.dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");
  const kDate = hmacSha256(`AWS4${input.secretAccessKey}`, input.dateStamp);
  const kRegion = hmacSha256(kDate, input.region);
  const kService = hmacSha256(kRegion, input.service);
  const kSigning = hmacSha256(kService, "aws4_request");
  return createHmac("sha256", kSigning).update(stringToSign).digest("hex");
}

/** S3 返回非 2xx 时抛出的错误；message 和 responseBody 只含服务端响应文本，不含任何凭据。 */
export class S3RequestError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, responseBody: string) {
    const truncated = responseBody.slice(0, 2_000);
    super(`S3 请求失败（HTTP ${status}）：${truncated.slice(0, 200)}`);
    this.name = "S3RequestError";
    this.status = status;
    this.responseBody = truncated;
  }
}

/** 最小化的 XML 文本实体解码；&amp; 必须最后替换，避免把 &amp;lt; 错误解码成 <。 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

/** 解析 ListObjectsV2 响应 XML，只提取备份流程需要的 key 列表和翻页标记。 */
export function parseListObjectsV2(xml: string): { keys: string[]; isTruncated: boolean; nextContinuationToken: string | null } {
  const keys: string[] = [];
  for (const match of xml.matchAll(/<Key(?:\s[^>]*)?>([\s\S]*?)<\/Key>/gu)) {
    keys.push(decodeXmlEntities(match[1] ?? ""));
  }
  const truncatedMatch = /<IsTruncated(?:\s[^>]*)?>\s*(true|false)\s*<\/IsTruncated>/u.exec(xml);
  const tokenMatch = /<NextContinuationToken(?:\s[^>]*)?>([\s\S]*?)<\/NextContinuationToken>/u.exec(xml);
  return {
    keys,
    isTruncated: truncatedMatch?.[1] === "true",
    nextContinuationToken: tokenMatch ? decodeXmlEntities(tokenMatch[1] ?? "") : null
  };
}

export interface S3ClientOptions {
  /** 如 "https://s3.us-east-1.amazonaws.com"，允许带 path 段，不允许查询串或片段。 */
  endpointUrl: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** true 使用 path style（MinIO 等），false 使用 virtual-host style（AWS S3 默认）。 */
  forcePathStyle: boolean;
  fetchImpl: typeof fetch;
  validateOutboundUrl?: SafeAiEndpointValidator;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** RFC3986 编码：encodeURIComponent 之外再补齐它遗漏的 ! ' ( ) *，~ 保持不编码。 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 对象 key 按路径段编码，段间斜杠保留。 */
function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeRfc3986).join("/");
}

function amzDateParts(now: Date): { amzDate: string; dateStamp: string } {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const dateStamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  return { dateStamp, amzDate: `${dateStamp}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z` };
}

/** 构造 canonical query：键值分别按 RFC3986 编码，再按编码后的键名字典序排序。 */
function buildCanonicalQuery(params: Array<[string, string]>): string {
  return params
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as [string, string])
    .sort(compareByName)
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

/** 零依赖的 S3 兼容存储客户端，只覆盖备份流程需要的 PUT、ListObjectsV2 和 DELETE。 */
export class S3Client {
  private readonly endpointProtocol: string;
  private readonly endpointHost: string;
  private readonly basePath: string;
  private readonly region: string;
  private readonly bucket: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly forcePathStyle: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly validateOutboundUrl?: SafeAiEndpointValidator;
  private readonly timeoutMs: number;

  constructor(options: S3ClientOptions) {
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpointUrl);
    } catch {
      throw new AppError(400, "INVALID_S3_ENDPOINT", "S3 端点地址无效");
    }
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
      throw new AppError(400, "INVALID_S3_ENDPOINT", "S3 端点地址只支持 http/https");
    }
    if (endpoint.search !== "" || endpoint.hash !== "") {
      throw new AppError(400, "INVALID_S3_ENDPOINT", "S3 端点地址不允许包含查询串或片段");
    }
    if (options.bucket.trim() === "") {
      throw new AppError(400, "INVALID_S3_CONFIG", "S3 桶名不能为空");
    }
    this.endpointProtocol = endpoint.protocol;
    this.endpointHost = endpoint.host;
    this.basePath = endpoint.pathname.replace(/\/+$/u, "");
    this.region = options.region;
    this.bucket = options.bucket;
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
    this.forcePathStyle = options.forcePathStyle;
    this.fetchImpl = options.fetchImpl;
    this.validateOutboundUrl = options.validateOutboundUrl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** 计算对象的 host 和 canonical 路径；key 为 null 表示桶级请求（如 ListObjectsV2）。 */
  private resolveTarget(key: string | null): { host: string; canonicalUri: string } {
    const keyPath = key === null ? "" : `/${encodeKeyPath(key)}`;
    if (this.forcePathStyle) {
      return { host: this.endpointHost, canonicalUri: `${this.basePath}/${encodeRfc3986(this.bucket)}${keyPath}` };
    }
    const canonicalUri = `${this.basePath}${keyPath}`;
    return { host: `${this.bucket}.${this.endpointHost}`, canonicalUri: canonicalUri === "" ? "/" : canonicalUri };
  }

  /** 构造对象 URL，供日志和测试使用。 */
  objectUrl(key: string): string {
    const { host, canonicalUri } = this.resolveTarget(key);
    return `${this.endpointProtocol}//${host}${canonicalUri}`;
  }

  private async request(
    method: string,
    key: string | null,
    query: Array<[string, string]>,
    body: Uint8Array | null,
    contentType: string | null
  ): Promise<Response> {
    const { host, canonicalUri } = this.resolveTarget(key);
    const canonicalQuery = buildCanonicalQuery(query);
    const url = `${this.endpointProtocol}//${host}${canonicalUri}${canonicalQuery === "" ? "" : `?${canonicalQuery}`}`;
    const payloadHashHex = body === null ? EMPTY_PAYLOAD_SHA256 : sha256Hex(body);
    const { amzDate, dateStamp } = amzDateParts(new Date());
    // host 只参与签名，实际请求头由 fetch 根据 URL 自动补上，避免手工设置导致不一致。
    const signingHeaders: Array<[string, string]> = [
      ["host", host],
      ["x-amz-content-sha256", payloadHashHex],
      ["x-amz-date", amzDate]
    ];
    if (contentType !== null) signingHeaders.push(["content-type", contentType]);
    signingHeaders.sort(compareByName);
    const signature = sigV4Signature({
      method,
      canonicalUri,
      canonicalQuery,
      headers: signingHeaders,
      payloadHashHex,
      region: this.region,
      service: "s3",
      secretAccessKey: this.secretAccessKey,
      amzDate,
      dateStamp
    });
    const signedHeaderNames = signingHeaders.map(([name]) => name).join(";");
    const headers: Record<string, string> = {
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHashHex,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${dateStamp}/${this.region}/s3/aws4_request, SignedHeaders=${signedHeaderNames}, Signature=${signature}`
    };
    if (contentType !== null) headers["content-type"] = contentType;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // slice() 产出以 ArrayBuffer 为底的 Uint8Array，满足 BodyInit 对 ArrayBufferView<ArrayBuffer> 的要求。
      const response = await fetchSafeAiEndpoint(
        this.fetchImpl,
        url,
        { method, headers, body: body === null ? null : body.slice(), signal: controller.signal },
        this.validateOutboundUrl
      );
      if (!response.ok) {
        const responseBody = (await response.text()).slice(0, 2_000);
        throw new S3RequestError(response.status, responseBody);
      }
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** 上传对象。 */
  async putObject(key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> {
    await this.request("PUT", key, [], body, contentType);
  }

  /** 列出指定前缀下的全部对象 key，自动跟随 IsTruncated/NextContinuationToken 翻页。 */
  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | null = null;
    do {
      const query: Array<[string, string]> = [["list-type", "2"], ["prefix", prefix]];
      if (continuationToken !== null) query.push(["continuation-token", continuationToken]);
      const response = await this.request("GET", null, query, null, null);
      const page = parseListObjectsV2(await response.text());
      keys.push(...page.keys);
      // 防御：服务端声明截断但没有返回 token 时停止翻页，避免死循环。
      continuationToken = page.isTruncated ? page.nextContinuationToken : null;
    } while (continuationToken !== null);
    return keys;
  }

  /** 删除对象。 */
  async deleteObject(key: string): Promise<void> {
    await this.request("DELETE", key, [], null, null);
  }
}
