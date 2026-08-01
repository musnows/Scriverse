import { createHash, createHmac } from "node:crypto";

/** S3 兼容客户端配置（明文凭据，仅在内存中短暂使用，绝不落库或打印）。 */
export type S3ClientOptions = {
  /** 服务地址，例如 https://s3.amazonaws.com 或 https://play.min.io。 */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export type S3ObjectInfo = {
  key: string;
  lastModified: string;
};

/** S3 服务端返回了非 2xx 响应，或网络层发生错误。 */
export class S3RequestError extends Error {
  /** HTTP 状态码；网络层错误时为 0。 */
  readonly status: number;
  /** S3 服务端返回的响应体（用于日志与前端提示）。 */
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "S3RequestError";
    this.status = status;
    this.body = body;
  }
}

const EMPTY_PAYLOAD_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 按 AWS SigV4 规则对查询参数值编码（与 encodeURIComponent 基本一致，但保留 ~）。 */
function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 对对象键按 '/' 分段编码，保留路径分隔符。 */
export function encodeObjectKey(key: string): string {
  return key.split("/").map((segment) => awsEncode(segment)).join("/");
}

export class S3Client {
  private readonly options: S3ClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: S3ClientOptions, fetchImpl: typeof fetch) {
    this.options = options;
    this.fetchImpl = fetchImpl;
  }

  /** 构造 path-style 对象 URL：{endpoint}/{bucket}/{key}。 */
  private objectUrl(key: string): URL {
    const base = this.options.endpoint.replace(/\/+$/u, "");
    return new URL(`${base}/${awsEncode(this.options.bucket)}/${encodeObjectKey(key)}`);
  }

  private buildAuthorization(url: URL, method: string, payloadHash: string, amzDate: string): string {
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${this.options.region}/${SERVICE}/aws4_request`;
    const canonicalHeaders = [
      `content-type:application/octet-stream`,
      `host:${url.host}`,
      `x-amz-content-sha256:${payloadHash}`,
      `x-amz-date:${amzDate}`
    ].join("\n");
    const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [
      method,
      url.pathname,
      url.search.replace(/^\?/u, ""),
      `${canonicalHeaders}\n`,
      signedHeaders,
      payloadHash
    ].join("\n");
    const stringToSign = [
      ALGORITHM,
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest)
    ].join("\n");
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.options.secretAccessKey}`, dateStamp), this.options.region), SERVICE),
      "aws4_request"
    );
    const signature = hmac(signingKey, stringToSign).toString("hex");
    return `${ALGORITHM} Credential=${this.options.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  }

  private async signedFetch(url: URL, method: string, body: Buffer | null, amzDate: string): Promise<Response> {
    const payloadHash = body ? sha256Hex(body) : EMPTY_PAYLOAD_HASH;
    const authorization = this.buildAuthorization(url, method, payloadHash, amzDate);
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      Authorization: authorization
    };
    try {
      const fetchBody = body ? new Uint8Array(body) : undefined;
      return await this.fetchImpl(url.toString(), { method, headers, body: fetchBody });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new S3RequestError(`S3 请求无法发送：${reason}`, 0, "");
    }
  }

  async putObject(key: string, body: Buffer, contentType = "application/octet-stream"): Promise<void> {
    const url = this.objectUrl(key);
    const amzDate = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
    const response = await this.signedFetch(url, "PUT", body, amzDate);
    if (response.status >= 200 && response.status < 300) return;
    const responseBody = await response.text().catch(() => "");
    throw new S3RequestError(`上传对象 ${key} 失败：HTTP ${response.status}`, response.status, responseBody);
  }

  /** 对象存在返回 true；不存在（404）返回 false；其它状态按失败抛出。 */
  async headObject(key: string): Promise<boolean> {
    const url = this.objectUrl(key);
    const amzDate = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
    const response = await this.signedFetch(url, "HEAD", null, amzDate);
    if (response.status >= 200 && response.status < 300) return true;
    if (response.status === 404) return false;
    const responseBody = await response.text().catch(() => "");
    throw new S3RequestError(`查询对象 ${key} 失败：HTTP ${response.status}`, response.status, responseBody);
  }

  async deleteObject(key: string): Promise<void> {
    const url = this.objectUrl(key);
    const amzDate = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
    const response = await this.signedFetch(url, "DELETE", null, amzDate);
    if (response.status >= 200 && response.status < 300) return;
    const responseBody = await response.text().catch(() => "");
    throw new S3RequestError(`删除对象 ${key} 失败：HTTP ${response.status}`, response.status, responseBody);
  }

  /** 列出指定前缀下的全部对象（自动翻页）。 */
  async listObjects(prefix: string): Promise<S3ObjectInfo[]> {
    const results: S3ObjectInfo[] = [];
    let continuationToken: string | null = null;
    do {
      const params = new URLSearchParams();
      params.set("list-type", "2");
      params.set("prefix", prefix);
      if (continuationToken) params.set("continuation-token", continuationToken);
      const base = this.options.endpoint.replace(/\/+$/u, "");
      const rawQuery = [...params.entries()]
        .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`)
        .sort()
        .join("&");
      const url = new URL(`${base}/${awsEncode(this.options.bucket)}/?${rawQuery}`);
      const amzDate = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
      const response = await this.signedFetch(url, "GET", null, amzDate);
      const body = await response.text().catch(() => "");
      if (response.status >= 200 && response.status < 300) {
        const parsed = parseListObjectsV2(body);
        results.push(...parsed.objects);
        continuationToken = parsed.isTruncated ? parsed.nextContinuationToken : null;
      } else {
        throw new S3RequestError(`列出对象前缀 ${prefix} 失败：HTTP ${response.status}`, response.status, body);
      }
    } while (continuationToken);
    return results;
  }
}

function parseListObjectsV2(body: string): {
  objects: S3ObjectInfo[];
  isTruncated: boolean;
  nextContinuationToken: string | null;
} {
  const objects: S3ObjectInfo[] = [];
  const contentRegex = /<Contents>([\s\S]*?)<\/Contents>/gu;
  const keyRegex = /<Key>([\s\S]*?)<\/Key>/u;
  const modifiedRegex = /<LastModified>([\s\S]*?)<\/LastModified>/u;
  let match: RegExpExecArray | null = contentRegex.exec(body);
  while (match) {
    const block = match[1] ?? "";
    const keyMatch = keyRegex.exec(block);
    const modifiedMatch = modifiedRegex.exec(block);
    if (keyMatch) {
      objects.push({
        key: decodeUriComponentSafe(keyMatch[1] ?? ""),
        lastModified: modifiedMatch ? (modifiedMatch[1] ?? "") : ""
      });
    }
    match = contentRegex.exec(body);
  }
  const isTruncated = /<IsTruncated\s*>?\s*true/iu.test(body);
  const tokenMatch = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/u.exec(body);
  return { objects, isTruncated, nextContinuationToken: tokenMatch ? (tokenMatch[1] ?? null) : null };
}

function decodeUriComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
