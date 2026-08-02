import { createHash, createHmac } from "node:crypto";
import { logger } from "./logger.js";

export type S3Object = {
  key: string;
  size: number;
  lastModified?: string;
};

export type UploadResult = {
  key: string;
  skipped?: boolean;
  size: number;
};

export type BackupFileResult = {
  key: string;
  size: number;
};

export type S3BackupConfig = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
};

export class S3RequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null,
    readonly responseBody: string,
    readonly configName: string
  ) {
    super(message);
    this.name = "S3RequestError";
  }
}

export function buildPrefixPath(prefix: string): string {
  const cleaned = prefix.replace(/^\/+|\/+$/gu, "").replace(/\/+/gu, "/");
  const parts = cleaned ? cleaned.split("/") : [];
  return ["scriverse", ...parts].join("/");
}

export function buildImageKey(prefix: string, fileName: string): string {
  return `${buildPrefixPath(prefix)}/img/${fileName}`;
}

export function buildDatabaseKey(prefix: string, fileName: string): string {
  return `${buildPrefixPath(prefix)}/db/${fileName}`;
}

function uriEncode(value: string, encodeSlash = true): string {
  return value.split("").map((char) => {
    if (/[A-Za-z0-9_.~-]/u.test(char)) return char;
    if (char === "/") return encodeSlash ? "%2F" : "/";
    return `%${char.codePointAt(0)!.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmacSha256Hex(key: Buffer | string, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function hmacSha256(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function getSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

export class S3Client {
  constructor(readonly config: S3BackupConfig) {}

  private get host(): string {
    const url = new URL(this.config.endpoint);
    return url.host;
  }

  private get scheme(): string {
    return new URL(this.config.endpoint).protocol;
  }

  private buildPath(key: string): string {
    if (this.config.forcePathStyle) {
      return `/${this.config.bucket}/${key}`;
    }
    return `/${key}`;
  }

  private async sign(method: string, path: string, query: Record<string, string>, headers: Record<string, string>, payloadHash: string, timestamp: string): Promise<string> {
    const dateStamp = timestamp.slice(0, 8);
    const canonicalHeaders = Object.entries(headers)
      .map(([key, value]) => `${key.toLocaleLowerCase("en-US")}:${value.trim()}`)
      .sort()
      .join("\n");
    const signedHeaders = Object.keys(headers)
      .map((key) => key.toLocaleLowerCase("en-US"))
      .sort()
      .join(";");
    const canonicalQueryString = Object.entries(query)
      .map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`)
      .sort()
      .join("&");
    const canonicalRequest = [
      method,
      uriEncode(path, false),
      canonicalQueryString,
      canonicalHeaders ? `${canonicalHeaders}\n` : "\n",
      signedHeaders,
      payloadHash
    ].join("\n");
    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      timestamp,
      credentialScope,
      sha256Hex(canonicalRequest)
    ].join("\n");
    const signingKey = getSigningKey(this.config.secretAccessKey, dateStamp, this.config.region, "s3");
    const signature = hmacSha256Hex(signingKey, stringToSign);
    return `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  }

  async listObjects(prefix: string): Promise<S3Object[]> {
    const now = new Date().toISOString().replace(/[:-]|\.\d{3}/gu, "");
    const headers: Record<string, string> = {
      host: this.host,
      "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "x-amz-date": now
    };
    const path = this.buildPath("");
    const query: Record<string, string> = {
      "list-type": "2",
      prefix,
      "max-keys": "1000"
    };
    const emptyHash = headers["x-amz-content-sha256"] ?? "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const authorization = await this.sign("GET", path, query, headers, emptyHash, now);
    const searchParams = new URLSearchParams(query);
    const url = `${this.scheme}//${this.host}${path}?${searchParams}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        ...headers,
        Authorization: authorization
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new S3RequestError(`S3 list failed for ${this.config.name}`, response.status, text, this.config.name);
    }
    return parseS3ListResponse(text);
  }

  async uploadObject(key: string, content: Buffer, contentType: string): Promise<void> {
    const now = new Date().toISOString().replace(/[:-]|\.\d{3}/gu, "");
    const payloadHash = sha256Hex(content.toString("latin1"));
    const headers: Record<string, string> = {
      host: this.host,
      "content-type": contentType,
      "content-length": String(content.byteLength),
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": now
    };
    const path = this.buildPath(key);
    const authorization = await this.sign("PUT", path, {}, headers, payloadHash, now);
    const response = await fetch(`${this.scheme}//${this.host}${path}`, {
      method: "PUT",
      headers: {
        ...headers,
        Authorization: authorization
      },
      body: new Uint8Array(content)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new S3RequestError(`S3 upload failed for ${this.config.name}`, response.status, text, this.config.name);
    }
  }

  async objectExists(key: string): Promise<boolean> {
    const now = new Date().toISOString().replace(/[:-]|\.\d{3}/gu, "");
    const headHash = sha256Hex("");
    const headers: Record<string, string> = {
      host: this.host,
      "x-amz-content-sha256": headHash,
      "x-amz-date": now
    };
    const path = this.buildPath(key);
    const authorization = await this.sign("HEAD", path, {}, headers, headHash, now);
    const response = await fetch(`${this.scheme}//${this.host}${path}`, {
      method: "HEAD",
      headers: {
        ...headers,
        Authorization: authorization
      }
    });
    return response.ok;
  }

  async deleteObject(key: string): Promise<void> {
    const now = new Date().toISOString().replace(/[:-]|\.\d{3}/gu, "");
    const deleteHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const headers: Record<string, string> = {
      host: this.host,
      "x-amz-content-sha256": deleteHash,
      "x-amz-date": now
    };
    const path = this.buildPath(key);
    const authorization = await this.sign("DELETE", path, {}, headers, deleteHash, now);
    const response = await fetch(`${this.scheme}//${this.host}${path}`, {
      method: "DELETE",
      headers: {
        ...headers,
        Authorization: authorization
      }
    });
    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      throw new S3RequestError(`S3 delete failed for ${this.config.name}`, response.status, text, this.config.name);
    }
  }

  async testConnection(): Promise<void> {
    const now = new Date().toISOString().replace(/[:-]|\.\d{3}/gu, "");
    const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const headers: Record<string, string> = {
      host: this.host,
      "x-amz-content-sha256": emptyHash,
      "x-amz-date": now
    };
    const path = this.buildPath("");
    const query: Record<string, string> = { "max-keys": "1" };
    const authorization = await this.sign("GET", path, query, headers, emptyHash, now);
    const searchParams = new URLSearchParams(query);
    const url = `${this.scheme}//${this.host}${path}?${searchParams}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        ...headers,
        Authorization: authorization
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new S3RequestError(`S3 connection test failed for ${this.config.name}`, response.status, text, this.config.name);
    }
    logger.info("s3_backup.connection_test.succeeded", { configName: this.config.name });
  }
}

export function formatErrorLog(error: unknown, config: S3BackupConfig, operation: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    operation,
    configId: config.id,
    configName: config.name,
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    prefix: config.prefix,
    forcePathStyle: config.forcePathStyle
  };
  if (error instanceof S3RequestError) {
    return {
      ...base,
      statusCode: error.statusCode,
      responseBody: error.responseBody.slice(0, 8000),
      message: error.message
    };
  }
  return {
    ...base,
    message: error instanceof Error ? error.message : String(error)
  };
}

function parseS3ListResponse(xml: string): S3Object[] {
  const results: S3Object[] = [];
  const contentMatches = xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu);
  for (const match of contentMatches) {
    const block = match[1];
    if (!block) continue;
    const keyMatch = block.match(/<Key>([\s\S]*?)<\/Key>/u);
    const sizeMatch = block.match(/<Size>([\s\S]*?)<\/Size>/u);
    const lastModifiedMatch = block.match(/<LastModified>([\s\S]*?)<\/LastModified>/u);
    if (!keyMatch?.[1]) continue;
    results.push({
      key: decodeXmlEntities(keyMatch[1]),
      size: Number(sizeMatch?.[1] ?? 0),
      lastModified: lastModifiedMatch?.[1]
    });
  }
  return results;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, "&");
}
