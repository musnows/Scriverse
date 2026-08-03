import { createHmac, createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { type Readable } from "node:stream";
import * as http from "node:http";
import * as https from "node:https";
import { type URL as UrlType } from "node:url";

const EMPTY_PAYLOAD_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const S3_SERVICE = "s3";

export type S3AddressStyle = "path" | "virtual-hosted";

export type S3Target = {
  /** S3 兼容服务的访问地址，例如 https://s3.amazonaws.com 或 https://play.min.io */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 寻址方式，默认 path-style 以最大化兼容 MinIO 等私有部署。 */
  addressStyle?: S3AddressStyle;
};

/** 对备份编排与测试友好的最小 S3 操作集合。 */
export interface S3Like {
  headObject(key: string): Promise<boolean>;
  putObject(key: string, filePath: string, contentType: string): Promise<void>;
  listObjects(prefix: string): Promise<string[]>;
  deleteObjects(keys: string[]): Promise<void>;
}

/** S3 服务端返回的失败明细，便于在日志与通知中完整呈现。 */
export class S3RequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly serverMessage: string;

  constructor(message: string, details: { status: number; code: string; serverMessage: string }) {
    super(message);
    this.name = "S3RequestError";
    this.status = details.status;
    this.code = details.code;
    this.serverMessage = details.serverMessage;
  }
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 严格 URI 编码：仅保留非保留字符，其余字节全部百分号编码（AWS SigV4 要求）。 */
function uriEncode(value: string): string {
  let result = "";
  for (const char of value) {
    if (/[A-Za-z0-9-._~]/u.test(char)) {
      result += char;
    } else {
      const codePoint = char.codePointAt(0) ?? 0x3f;
      result += `%${codePoint.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return result;
}

function parseEndpoint(endpoint: string): { protocol: string; host: string; portRaw: string } {
  let url: UrlType;
  try {
    url = new URL(endpoint);
  } catch {
    throw new S3RequestError("S3 终端地址格式无效", { status: 0, code: "INVALID_ENDPOINT", serverMessage: endpoint });
  }
  const protocol = url.protocol === "http:" ? "http:" : "https:";
  return { protocol, host: url.hostname, portRaw: url.port };
}

function hostHeader(protocol: string, host: string, portRaw: string): string {
  const port = portRaw ? Number(portRaw) : protocol === "https:" ? 443 : 80;
  const defaultPort = protocol === "https:" ? 443 : 80;
  return port === defaultPort ? host : `${host}:${port}`;
}

function computeSignatureKey(secretAccessKey: string, dateStamp: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, S3_SERVICE);
  return hmac(kService, "aws4_request");
}

type SignedRequestOptions = {
  method: string;
  bucket: string;
  key?: string;
  query?: Array<[string, string]>;
  payloadHash?: string;
  body?: string;
  filePath?: string;
  contentType?: string;
  /** 当使用流式上传时，必须显式声明 UNSIGNED-PAYLOAD 且不提供 payloadHash。 */
  unsignedPayload?: boolean;
};

type SignedResponse = { status: number; body: string };

function extractXmlTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "u"));
  return match?.[1]?.trim() ?? null;
}

function parseError(xml: string, status: number, fallback: string): { code: string; serverMessage: string } {
  const code = extractXmlTag(xml, "Code") ?? "UNKNOWN";
  const message = extractXmlTag(xml, "Message") ?? fallback;
  return { code, serverMessage: message };
}

export class S3Client implements S3Like {
  private readonly target: S3Target;
  private readonly protocol: string;
  private readonly host: string;
  private readonly portRaw: string;
  private readonly addressStyle: S3AddressStyle;

  constructor(target: S3Target) {
    this.target = target;
    const parsed = parseEndpoint(target.endpoint);
    this.protocol = parsed.protocol;
    this.host = parsed.host;
    this.portRaw = parsed.portRaw;
    this.addressStyle = target.addressStyle ?? "path";
  }

  private requestHostHeader(): string {
    return hostHeader(this.protocol, this.host, this.portRaw);
  }

  private objectPath(key: string): string {
    const encodedKey = key.split("/").map((segment) => uriEncode(segment)).join("/");
    if (this.addressStyle === "virtual-hosted") return `/${encodedKey}`;
    return `/${uriEncode(this.target.bucket)}/${encodedKey}`;
  }

  private requestHost(): string {
    return this.addressStyle === "virtual-hosted" ? `${this.target.bucket}.${this.host}` : this.host;
  }

  private async send(options: SignedRequestOptions): Promise<SignedResponse> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}/u, "");
    const dateStamp = amzDate.slice(0, 8);
    const region = this.target.region.trim() || "us-east-1";

    const canonicalUri = options.key !== undefined ? this.objectPath(options.key) : `/${uriEncode(this.target.bucket)}`;
    const query = options.query ?? [];
    const canonicalQuery = [...query]
      .map(([name, value]) => [uriEncode(name), uriEncode(value)] as [string, string])
      .sort((left, right) => left[0] === right[0] ? left[1].localeCompare(right[1]) : left[0].localeCompare(right[0]))
      .map(([name, value]) => `${name}=${value}`)
      .join("&");

    const payloadHash = options.unsignedPayload ? UNSIGNED_PAYLOAD : (options.payloadHash ?? EMPTY_PAYLOAD_HASH);
    const hostValue = this.requestHostHeader();
    const canonicalHeaders = {
      host: this.requestHost(),
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate
    };
    const signedHeaderNames = Object.keys(canonicalHeaders).sort();
    const canonicalHeadersString = signedHeaderNames
      .map((name) => `${name}:${canonicalHeaders[name as keyof typeof canonicalHeaders]}\n`)
      .join("");
    const signedHeaders = signedHeaderNames.join(";");

    const canonicalRequest = [
      options.method,
      canonicalUri,
      canonicalQuery,
      canonicalHeadersString,
      signedHeaders,
      payloadHash
    ].join("\n");

    const scope = `${dateStamp}/${region}/${S3_SERVICE}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256Hex(canonicalRequest)
    ].join("\n");
    const signature = createHmac("sha256", computeSignatureKey(this.target.secretAccessKey, dateStamp, region))
      .update(stringToSign)
      .digest("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.target.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const requestPath = canonicalQuery ? `${canonicalUri}?${canonicalQuery}` : canonicalUri;
    const headers: Record<string, string> = {
      Host: hostValue,
      Authorization: authorization,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate
    };
    if (options.contentType) headers["Content-Type"] = options.contentType;
    if (options.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(options.body));

    const transport = this.protocol === "https:" ? https : http;
    const port = this.portRaw ? Number(this.portRaw) : this.protocol === "https:" ? 443 : 80;

    const responseBody = await new Promise<SignedResponse>((resolve, reject) => {
      const request = transport.request(
        {
          protocol: this.protocol,
          host: this.requestHost(),
          port,
          method: options.method,
          path: requestPath,
          headers
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        }
      );
      request.on("error", (error) => reject(new S3RequestError(
        `S3 请求无法建立连接：${error.message}`,
        { status: 0, code: "CONNECTION_ERROR", serverMessage: error.message }
      )));
      if (options.filePath) {
        const size = statSync(options.filePath).size;
        request.setHeader("Content-Length", String(size));
        const stream: Readable = createReadStream(options.filePath);
        stream.on("error", (error) => reject(new S3RequestError(
          `读取待上传文件失败：${error.message}`,
          { status: 0, code: "FILE_READ_ERROR", serverMessage: error.message }
        )));
        stream.pipe(request);
      } else if (options.body !== undefined) {
        request.end(options.body);
      } else {
        request.end();
      }
    });
    return responseBody;
  }

  async headObject(key: string): Promise<boolean> {
    const response = await this.send({ method: "HEAD", bucket: this.target.bucket, key, payloadHash: EMPTY_PAYLOAD_HASH });
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    const error = parseError(response.body, response.status, "对象元数据查询失败");
    throw new S3RequestError(
      `查询对象是否存在失败（${error.code}）：${error.serverMessage}`,
      { status: response.status, code: error.code, serverMessage: error.serverMessage }
    );
  }

  async putObject(key: string, filePath: string, contentType: string): Promise<void> {
    const response = await this.send({
      method: "PUT",
      bucket: this.target.bucket,
      key,
      contentType,
      filePath,
      unsignedPayload: true
    });
    if (response.status >= 200 && response.status < 300) return;
    const error = parseError(response.body, response.status, "对象上传失败");
    throw new S3RequestError(
      `上传对象失败（${error.code}）：${error.serverMessage}`,
      { status: response.status, code: error.code, serverMessage: error.serverMessage }
    );
  }

  async listObjects(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | null = null;
    do {
      const query: Array<[string, string]> = [["list-type", "2"], ["prefix", prefix]];
      if (continuationToken) query.push(["continuation-token", continuationToken]);
      const response = await this.send({ method: "GET", bucket: this.target.bucket, query, payloadHash: EMPTY_PAYLOAD_HASH });
      if (response.status !== 200) {
        const error = parseError(response.body, response.status, "列举对象失败");
        throw new S3RequestError(
          `列举对象失败（${error.code}）：${error.serverMessage}`,
          { status: response.status, code: error.code, serverMessage: error.serverMessage }
        );
      }
      const contentsMatches = response.body.match(/<Contents>([\s\S]*?)<\/Contents>/gu) ?? [];
      for (const content of contentsMatches) {
        const key = extractXmlTag(content, "Key");
        if (key) keys.push(key);
      }
      const truncated = extractXmlTag(response.body, "IsTruncated") === "true";
      const nextToken = extractXmlTag(response.body, "NextContinuationToken");
      continuationToken = truncated && nextToken ? nextToken : null;
    } while (continuationToken);
    return keys;
  }

  async deleteObjects(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const objectsXml = keys.map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`).join("");
    const body = `<?xml version="1.0" encoding="UTF-8"?><Delete>${objectsXml}</Delete>`;
    const response = await this.send({
      method: "POST",
      bucket: this.target.bucket,
      query: [["delete", ""]],
      body,
      payloadHash: sha256Hex(body)
    });
    if (response.status >= 200 && response.status < 300) return;
    const error = parseError(response.body, response.status, "删除对象失败");
    throw new S3RequestError(
      `删除对象失败（${error.code}）：${error.serverMessage}`,
      { status: response.status, code: error.code, serverMessage: error.serverMessage }
    );
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

export function createS3Client(target: S3Target): S3Like {
  return new S3Client(target);
}
