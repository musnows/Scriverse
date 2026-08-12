import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AppError } from "./errors.js";
import { parseS3ErrorResult, parseS3ListResult } from "./s3-backup-paths.js";

const emptyPayloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const unsignedPayload = "UNSIGNED-PAYLOAD";

export type S3TargetPublicConfig = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  enabled: boolean;
};

export type S3ClientCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
};

export class S3RequestError extends Error {
  readonly code = "S3_REQUEST_FAILED";

  constructor(
    message: string,
    readonly publicConfig: S3TargetPublicConfig,
    readonly method: string,
    readonly objectKey: string,
    readonly status: number,
    readonly responseBody: string
  ) {
    super(message);
    this.name = "S3RequestError";
  }
}

export type S3ClientOptions = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function uriEncode(value: string, encodeSlash = true): string {
  return encodeURIComponent(value).replaceAll(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`).replaceAll("%2F", encodeSlash ? "%2F" : "/");
}

function canonicalPath(pathname: string): string {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return normalized.split("/").map((segment) => uriEncode(segment, true)).join("/");
}

function signingKey(secret: string, dateStamp: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), "s3"), "aws4_request");
}

function amzDate(at: Date): { amzDate: string; dateStamp: string } {
  const stamp = at.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  return { amzDate: stamp, dateStamp: stamp.slice(0, 8) };
}

function endpointUrl(endpoint: string): URL {
  try {
    return new URL(endpoint);
  } catch {
    throw new AppError(400, "INVALID_S3_ENDPOINT", "S3 服务地址不是有效的 URL");
  }
}

function objectRequestUrl(config: S3TargetPublicConfig, objectKey: string, query = ""): URL {
  const endpoint = endpointUrl(config.endpoint);
  const encodedKey = objectKey.split("/").filter(Boolean).map((segment) => uriEncode(segment, true)).join("/");
  const keyPath = encodedKey ? `/${encodedKey}` : "";
  if (config.forcePathStyle) {
    const basePath = endpoint.pathname.replace(/\/+$/u, "");
    endpoint.pathname = `${basePath}/${uriEncode(config.bucket, true)}${keyPath}`;
  } else {
    endpoint.hostname = `${config.bucket}.${endpoint.hostname}`;
    const basePath = endpoint.pathname.replace(/\/+$/u, "");
    endpoint.pathname = `${basePath}${keyPath || "/"}`;
  }
  endpoint.search = query;
  return endpoint;
}

export class S3CompatibleClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(options: S3ClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async headObject(config: S3TargetPublicConfig, credentials: S3ClientCredentials, objectKey: string): Promise<boolean> {
    const response = await this.request(config, credentials, "HEAD", objectKey);
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    return this.throwRequestError(config, "HEAD", objectKey, response);
  }

  async putFile(
    config: S3TargetPublicConfig,
    credentials: S3ClientCredentials,
    objectKey: string,
    filePath: string,
    contentType: string
  ): Promise<void> {
    const body = await readFile(filePath);
    const response = await this.request(config, credentials, "PUT", objectKey, {
      body,
      contentType,
      contentLength: body.byteLength,
      unsigned: true
    });
    if (response.status !== 200 && response.status !== 204) this.throwRequestError(config, "PUT", objectKey, response);
  }

  async listObjectKeys(config: S3TargetPublicConfig, credentials: S3ClientCredentials, prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | null = null;
    do {
      const query = new URLSearchParams({ "list-type": "2", prefix, "max-keys": "1000" });
      if (continuationToken) query.set("continuation-token", continuationToken);
      const response = await this.request(config, credentials, "GET", "", { query });
      if (response.status !== 200) this.throwRequestError(config, "GET", prefix, response);
      const listed = parseS3ListResult(response.body);
      keys.push(...listed.keys);
      continuationToken = listed.truncated ? listed.continuationToken : null;
    } while (continuationToken);
    return keys;
  }

  async deleteObject(config: S3TargetPublicConfig, credentials: S3ClientCredentials, objectKey: string): Promise<void> {
    const response = await this.request(config, credentials, "DELETE", objectKey);
    if (response.status !== 200 && response.status !== 204) this.throwRequestError(config, "DELETE", objectKey, response);
  }

  private throwRequestError(
    config: S3TargetPublicConfig,
    method: string,
    objectKey: string,
    response: { status: number; body: string }
  ): never {
    const parsed = parseS3ErrorResult(response.body);
    const detail = parsed.code ? `${parsed.code}: ${parsed.message}` : (response.body.trim() || `HTTP ${response.status}`);
    throw new S3RequestError(
      `S3 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`,
      config,
      method,
      objectKey,
      response.status,
      response.body
    );
  }

  private async request(
    config: S3TargetPublicConfig,
    credentials: S3ClientCredentials,
    method: string,
    objectKey: string,
    options: {
      body?: BodyInit | null;
      contentType?: string;
      contentLength?: number;
      unsigned?: boolean;
      query?: URLSearchParams;
    } = {}
  ): Promise<{ status: number; body: string }> {
    const url = objectRequestUrl(config, objectKey, options.query ? `?${options.query.toString()}` : "");
    const { amzDate: dateHeader, dateStamp } = amzDate(this.now());
    const payloadHash = options.unsigned ? unsignedPayload : emptyPayloadHash;
    const headerMap: Record<string, string> = {
      host: url.host,
      "x-amz-date": dateHeader,
      "x-amz-content-sha256": payloadHash
    };
    if (options.contentType) headerMap["content-type"] = options.contentType;
    if (options.contentLength !== undefined) headerMap["content-length"] = String(options.contentLength);
    const signedHeaderNames = Object.keys(headerMap).sort();
    const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headerMap[name]?.trim() ?? ""}\n`).join("");
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalQuery = [...url.searchParams.entries()]
      .map(([key, value]) => [uriEncode(key, true), uriEncode(value, true)] as const)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join("&");
    const canonicalRequest = [
      method,
      canonicalPath(url.pathname),
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join("\n");
    const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${dateHeader}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
    const signature = createHmac("sha256", signingKey(credentials.secretAccessKey, dateStamp, config.region))
      .update(stringToSign, "utf8")
      .digest("hex");
    const headers = new Headers();
    for (const [name, value] of Object.entries(headerMap)) {
      if (name === "host") continue;
      headers.set(name, value);
    }
    headers.set(
      "authorization",
      `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    );
    const response = await this.fetchImpl(url.toString(), {
      method,
      headers,
      body: options.body ?? undefined,
      redirect: "manual"
    });
    const body = method === "HEAD" ? "" : await response.text();
    if (response.status >= 300 && response.status < 400) {
      throw new S3RequestError(
        `S3 返回了不安全的重定向（HTTP ${response.status}）`,
        config,
        method,
        objectKey,
        response.status,
        body || response.headers.get("location") || ""
      );
    }
    return { status: response.status, body };
  }
}
