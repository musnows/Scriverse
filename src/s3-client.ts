import { createHash, createHmac } from "node:crypto";

export type S3ClientConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
};

export type S3ListedObject = {
  key: string;
  lastModified: string | null;
  size: number;
};

export class S3RequestError extends Error {
  readonly status: number;
  readonly responseBody: string;
  readonly operation: string;
  readonly objectKey: string | null;

  constructor(options: {
    message: string;
    status: number;
    responseBody: string;
    operation: string;
    objectKey?: string | null;
  }) {
    super(options.message);
    this.name = "S3RequestError";
    this.status = options.status;
    this.responseBody = options.responseBody;
    this.operation = options.operation;
    this.objectKey = options.objectKey ?? null;
  }
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeS3Key(key: string): string {
  return key.split("/").map((segment) => encodeRfc3986(segment)).join("/");
}

function amzDate(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function normalizeEndpoint(endpoint: string): URL {
  const trimmed = endpoint.trim();
  const withProtocol = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withProtocol);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("S3 endpoint must use http or https");
  }
  return url;
}

function signingKey(secretAccessKey: string, dateStamp: string, region: string): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

export class S3CompatibleClient {
  private readonly endpoint: URL;
  private readonly region: string;
  private readonly bucket: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly forcePathStyle: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(config: S3ClientConfig, fetchImpl: typeof fetch = fetch) {
    this.endpoint = normalizeEndpoint(config.endpoint);
    this.region = config.region.trim() || "us-east-1";
    this.bucket = config.bucket.trim();
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
    this.forcePathStyle = config.forcePathStyle !== false;
    this.fetchImpl = fetchImpl;
  }

  private objectUrl(key: string, query = ""): { url: URL; canonicalUri: string; host: string } {
    const normalizedKey = key.replace(/^\/+/u, "");
    const encodedKey = normalizedKey ? encodeS3Key(normalizedKey) : "";
    if (this.forcePathStyle) {
      const url = new URL(this.endpoint);
      const path = encodedKey ? `/${this.bucket}/${encodedKey}` : `/${this.bucket}`;
      url.pathname = path;
      if (query) url.search = query.startsWith("?") ? query.slice(1) : query;
      const canonicalUri = encodedKey
        ? `/${encodeRfc3986(this.bucket)}/${encodedKey}`
        : `/${encodeRfc3986(this.bucket)}`;
      return { url, canonicalUri, host: url.host };
    }
    const url = new URL(this.endpoint);
    url.host = `${this.bucket}.${url.host}`;
    url.pathname = encodedKey ? `/${encodedKey}` : "/";
    if (query) url.search = query.startsWith("?") ? query.slice(1) : query;
    return {
      url,
      canonicalUri: encodedKey ? `/${encodedKey}` : "/",
      host: url.host
    };
  }

  private async signedFetch(input: {
    method: string;
    key?: string;
    query?: string;
    body?: Buffer | Uint8Array | string;
    headers?: Record<string, string>;
    operation: string;
  }): Promise<Response> {
    const now = new Date();
    const { amzDate: amz, dateStamp } = amzDate(now);
    const { url, canonicalUri, host } = this.objectUrl(input.key ?? "", input.query ?? "");
    const payloadHash = sha256Hex(input.body ? Buffer.from(input.body) : "");
    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amz,
      ...(input.headers ?? {})
    };
    if (input.body !== undefined) {
      headers["content-length"] = String(Buffer.byteLength(input.body));
    }
    const signedHeaderNames = Object.keys(headers).map((name) => name.toLowerCase()).sort();
    const canonicalHeaders = signedHeaderNames.map((name) => {
      const value = headers[name];
      return `${name}:${String(value ?? "").trim()}\n`;
    }).join("");
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalQuery = [...url.searchParams.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
      .join("&");
    const canonicalRequest = [
      input.method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join("\n");
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amz,
      credentialScope,
      sha256Hex(canonicalRequest)
    ].join("\n");
    const signature = createHmac("sha256", signingKey(this.secretAccessKey, dateStamp, this.region))
      .update(stringToSign, "utf8")
      .digest("hex");
    headers.authorization = [
      `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signature}`
    ].join(", ");

    const response = await this.fetchImpl(url, {
      method: input.method,
      headers,
      body: input.body === undefined ? undefined : Buffer.from(input.body)
    });
    return response;
  }

  private async readErrorBody(response: Response): Promise<string> {
    try {
      return (await response.text()).slice(0, 8_000);
    } catch {
      return "";
    }
  }

  async headObject(key: string): Promise<{ exists: boolean }> {
    const response = await this.signedFetch({ method: "HEAD", key, operation: "HeadObject" });
    if (response.status === 200) return { exists: true };
    if (response.status === 404) return { exists: false };
    const body = await this.readErrorBody(response);
    throw new S3RequestError({
      message: `S3 HeadObject failed with HTTP ${response.status}`,
      status: response.status,
      responseBody: body,
      operation: "HeadObject",
      objectKey: key
    });
  }

  async putObject(key: string, body: Buffer | Uint8Array, contentType = "application/octet-stream"): Promise<void> {
    const response = await this.signedFetch({
      method: "PUT",
      key,
      body,
      headers: { "content-type": contentType },
      operation: "PutObject"
    });
    if (response.status >= 200 && response.status < 300) {
      await response.arrayBuffer().catch(() => undefined);
      return;
    }
    const responseBody = await this.readErrorBody(response);
    throw new S3RequestError({
      message: `S3 PutObject failed with HTTP ${response.status}`,
      status: response.status,
      responseBody,
      operation: "PutObject",
      objectKey: key
    });
  }

  async listObjects(prefix: string): Promise<S3ListedObject[]> {
    const objects: S3ListedObject[] = [];
    let continuationToken: string | undefined;
    do {
      const params = new URLSearchParams({
        "list-type": "2",
        prefix,
        "max-keys": "1000"
      });
      if (continuationToken) params.set("continuation-token", continuationToken);
      const response = await this.signedFetch({
        method: "GET",
        query: params.toString(),
        operation: "ListObjectsV2"
      });
      const responseBody = await this.readErrorBody(response);
      if (!(response.status >= 200 && response.status < 300)) {
        throw new S3RequestError({
          message: `S3 ListObjectsV2 failed with HTTP ${response.status}`,
          status: response.status,
          responseBody,
          operation: "ListObjectsV2",
          objectKey: prefix
        });
      }
      const keys = [...responseBody.matchAll(/<Key>([^<]*)<\/Key>/gu)].map((match) => decodeXml(match[1] ?? ""));
      const modified = [...responseBody.matchAll(/<LastModified>([^<]*)<\/LastModified>/gu)].map((match) => match[1] ?? null);
      const sizes = [...responseBody.matchAll(/<Size>([^<]*)<\/Size>/gu)].map((match) => Number(match[1] ?? 0));
      for (let index = 0; index < keys.length; index += 1) {
        objects.push({
          key: keys[index]!,
          lastModified: modified[index] ?? null,
          size: Number.isFinite(sizes[index]) ? sizes[index]! : 0
        });
      }
      const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/iu.test(responseBody);
      const next = responseBody.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/u)?.[1];
      continuationToken = truncated && next ? decodeXml(next) : undefined;
    } while (continuationToken);
    return objects;
  }

  async deleteObject(key: string): Promise<void> {
    const response = await this.signedFetch({ method: "DELETE", key, operation: "DeleteObject" });
    if (response.status >= 200 && response.status < 300 || response.status === 404) {
      await response.arrayBuffer().catch(() => undefined);
      return;
    }
    const responseBody = await this.readErrorBody(response);
    throw new S3RequestError({
      message: `S3 DeleteObject failed with HTTP ${response.status}`,
      status: response.status,
      responseBody,
      operation: "DeleteObject",
      objectKey: key
    });
  }
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
