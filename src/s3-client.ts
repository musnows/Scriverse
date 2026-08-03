import { createHash, createHmac } from "node:crypto";

export type S3TargetConfig = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  subdirectory: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

export type S3Response = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type S3ListEntry = {
  key: string;
  size: number;
  lastModified: string;
};

export type S3ListResult = {
  contents: S3ListEntry[];
  isTruncated: boolean;
  nextContinuationToken: string | null;
};

export type S3TargetLogInfo = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  subdirectory: string;
  forcePathStyle: boolean;
  enabled: boolean;
};

export class S3RequestError extends Error {
  readonly status: number;
  readonly responseHeaders: Record<string, string>;
  readonly responseBody: string;
  readonly targetConfig: S3TargetLogInfo;
  readonly operation: string;
  readonly objectKey: string | null;

  constructor(options: {
    operation: string;
    objectKey: string | null;
    message: string;
    response: S3Response;
    targetConfig: S3TargetLogInfo;
  }) {
    super(options.message);
    this.name = "S3RequestError";
    this.operation = options.operation;
    this.objectKey = options.objectKey;
    this.status = options.response.status;
    this.responseHeaders = options.response.headers;
    this.responseBody = options.response.body;
    this.targetConfig = options.targetConfig;
  }
}

export function sanitizeTargetForLog(config: S3TargetConfig): S3TargetLogInfo {
  return {
    id: config.id,
    name: config.name,
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    subdirectory: config.subdirectory,
    forcePathStyle: config.forcePathStyle,
    enabled: true
  };
}

type FetchImpl = typeof fetch;

export type S3ClientOptions = {
  fetchImpl?: FetchImpl;
  now?: () => Date;
};

const EMPTY_PAYLOAD_HASH = createHash("sha256").update("").digest("hex");

function trimAll(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function uriEncodePath(value: string): string {
  return encodeURIComponent(value).replace(/%2F/giu, "/").replace(/[!'()*]/gu, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function uriEncodeComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function deriveSigningKey(secretAccessKey: string, date: string, region: string, service: string): Buffer {
  const dateKey = hmacSha256(`AWS4${secretAccessKey}`, date);
  const dateRegionKey = hmacSha256(dateKey, region);
  const dateRegionServiceKey = hmacSha256(dateRegionKey, service);
  return hmacSha256(dateRegionServiceKey, "aws4_request");
}

function splitEndpoint(endpoint: string): { protocol: string; host: string; port: string | null } {
  const trimmed = endpoint.trim().replace(/\/+$/u, "");
  const match = /^(https?):\/\/([^:/]+)(:\d+)?/iu.exec(trimmed);
  if (!match) throw new Error(`S3 端点地址无效：${endpoint}`);
  const [, protocol = "", host = "", portMatch] = match;
  return { protocol, host, port: portMatch ?? null };
}

function buildRequestUrl(config: S3TargetConfig, key: string, query: Array<[string, string]>): { url: string; host: string; path: string } {
  const { protocol, host, port } = splitEndpoint(config.endpoint);
  const encodedKey = key.split("/").map((segment) => uriEncodeComponent(segment)).join("/");
  const hostWithPort = port ? `${host}${port}` : host;
  let path: string;
  let requestHost: string;
  if (config.forcePathStyle) {
    path = `/${config.bucket}/${encodedKey}`;
    requestHost = hostWithPort;
  } else {
    path = `/${encodedKey}`;
    requestHost = `${config.bucket}.${hostWithPort}`;
  }
  const queryString = query.length > 0
    ? `?${query.map(([name, value]) => `${uriEncodeComponent(name)}=${uriEncodeComponent(value)}`).join("&")}`
    : "";
  return { url: `${protocol}://${requestHost}${path}${queryString}`, host: requestHost, path };
}

function canonicalQueryString(query: Array<[string, string]>): string {
  if (query.length === 0) return "";
  return [...query]
    .map(([name, value]) => [uriEncodeComponent(name), uriEncodeComponent(value)] as [string, string])
    .sort(([aName], [bName]) => (aName < bName ? -1 : aName > bName ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function buildAuthorizationHeader(
  config: S3TargetConfig,
  method: string,
  host: string,
  path: string,
  query: Array<[string, string]>,
  headers: Record<string, string>,
  payloadHash: string,
  timestamp: Date
): string {
  const dateTime = timestamp.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  const date = dateTime.slice(0, 8);
  const region = config.region || "us-east-1";
  const service = "s3";
  const canonicalHeaders = Object.entries(headers)
    .map(([name, value]) => [name.toLocaleLowerCase(), trimAll(value)] as [string, string])
    .sort(([aName], [bName]) => (aName < bName ? -1 : aName > bName ? 1 : 0));
  const canonicalHeadersString = canonicalHeaders.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaders = canonicalHeaders.map(([name]) => name).join(";");
  const canonicalUri = uriEncodePath(path);
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString(query),
    canonicalHeadersString,
    signedHeaders,
    payloadHash
  ].join("\n");
  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    dateTime,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");
  const signingKey = deriveSigningKey(config.secretAccessKey, date, region, service);
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function readResponseHeaders(headers: Headers): Promise<Record<string, string>> {
  const collected: Record<string, string> = {};
  headers.forEach((value, name) => {
    collected[name.toLocaleLowerCase()] = value;
  });
  return collected;
}

export class S3Client {
  private readonly fetchImpl: FetchImpl;
  private readonly now: () => Date;

  constructor(options: S3ClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  private async sendRequest(
    config: S3TargetConfig,
    method: string,
    key: string,
    query: Array<[string, string]>,
    body: Buffer | null,
    extraHeaders: Record<string, string> = {}
  ): Promise<S3Response> {
    const { url, host, path } = buildRequestUrl(config, key, query);
    const timestamp = this.now();
    const dateTime = timestamp.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
    const payloadHash = body ? sha256Hex(body) : EMPTY_PAYLOAD_HASH;
    const headers: Record<string, string> = {
      host,
      "x-amz-date": dateTime,
      "x-amz-content-sha256": payloadHash,
      ...extraHeaders
    };
    const authorization = buildAuthorizationHeader(config, method, host, path, query, headers, payloadHash, timestamp);
    const requestHeaders: Record<string, string> = { ...headers, authorization };
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: requestHeaders,
        body: body ? new Uint8Array(body) : undefined,
        redirect: "error"
      });
    } catch (error) {
      const logInfo = sanitizeTargetForLog(config);
      throw new S3RequestError({
        operation: method,
        objectKey: key,
        message: error instanceof Error ? `S3 请求失败：${error.message}` : "S3 请求失败",
        response: { status: 0, headers: {}, body: error instanceof Error ? error.message : String(error) },
        targetConfig: logInfo
      });
    }
    const responseHeaders = await readResponseHeaders(response.headers);
    const responseText = await response.text();
    return { status: response.status, headers: responseHeaders, body: responseText };
  }

  private assertSuccess(
    response: S3Response,
    config: S3TargetConfig,
    operation: string,
    key: string,
    expectedStatus: number[]
  ): void {
    if (expectedStatus.includes(response.status)) return;
    const logInfo = sanitizeTargetForLog(config);
    throw new S3RequestError({
      operation,
      objectKey: key,
      message: `S3 服务返回错误状态 ${response.status}`,
      response,
      targetConfig: logInfo
    });
  }

  async headObject(config: S3TargetConfig, key: string): Promise<boolean> {
    const response = await this.sendRequest(config, "HEAD", key, [], null);
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    this.assertSuccess(response, config, "HEAD", key, [200, 404]);
    return false;
  }

  async putObject(config: S3TargetConfig, key: string, body: Buffer, contentType: string): Promise<void> {
    const response = await this.sendRequest(config, "PUT", key, [], body, { "content-type": contentType });
    this.assertSuccess(response, config, "PUT", key, [200]);
  }

  async deleteObject(config: S3TargetConfig, key: string): Promise<void> {
    const response = await this.sendRequest(config, "DELETE", key, [], null);
    if (response.status === 204 || response.status === 200) return;
    this.assertSuccess(response, config, "DELETE", key, [200, 204]);
  }

  async listObjects(config: S3TargetConfig, prefix: string, continuationToken: string | null = null): Promise<S3ListResult> {
    const query: Array<[string, string]> = [
      ["list-type", "2"],
      ["prefix", prefix]
    ];
    if (continuationToken) query.push(["continuation-token", continuationToken]);
    const response = await this.sendRequest(config, "GET", "", query, null);
    this.assertSuccess(response, config, "LIST", "", [200]);
    return parseListObjectsResponse(response.body);
  }

  async listAllObjects(config: S3TargetConfig, prefix: string): Promise<S3ListEntry[]> {
    const all: S3ListEntry[] = [];
    let token: string | null = null;
    do {
      const result = await this.listObjects(config, prefix, token);
      all.push(...result.contents);
      token = result.isTruncated ? result.nextContinuationToken : null;
    } while (token);
    return all;
  }
}

function parseListObjectsResponse(xml: string): S3ListResult {
  const contents: S3ListEntry[] = [];
  const entryRegex = /<Contents>([\s\S]*?)<\/Contents>/giu;
  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1] ?? "";
    contents.push({
      key: extractTag(block, "Key"),
      size: Number(extractTag(block, "Size") || "0"),
      lastModified: extractTag(block, "LastModified")
    });
  }
  const isTruncated = /<IsTruncated>true<\/IsTruncated>/iu.test(xml);
  const nextTokenMatch = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/iu.exec(xml);
  return {
    contents,
    isTruncated,
    nextContinuationToken: nextTokenMatch && nextTokenMatch[1] ? nextTokenMatch[1] : null
  };
}

function extractTag(block: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "iu").exec(block);
  return match && match[1] ? decodeXmlEntities(match[1]) : "";
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}
