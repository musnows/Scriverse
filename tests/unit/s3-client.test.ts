import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { S3CompatClient, S3ServiceError, contentTypeForStorageKey, uriEncode } from "../../src/s3-client.js";

const testAccessKey = "AKIAIOSFODNN7EXAMPLE";
const testSecretKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const testClock = () => new Date("2013-05-24T00:00:00Z");

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

/** 独立按 AWS SigV4 流程计算期望签名，与客户端实现比对。 */
function expectedSignature(options: {
  method: string;
  path: string;
  query: string;
  host: string;
  payload: Buffer;
  accessKeyId: string;
  secretAccessKey: string;
}): string {
  const amzDate = "20130524T000000Z";
  const shortDate = "20130524";
  const payloadHash = sha256Hex(options.payload);
  const canonicalHeaders = `host:${options.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    options.method,
    options.path,
    options.query,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");
  const scope = `${shortDate}/us-east-1/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const dateKey = hmac(`AWS4${options.secretAccessKey}`, shortDate);
  const regionKey = hmac(dateKey, "us-east-1");
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  return hmac(signingKey, stringToSign).toString("hex");
}

function captureFetch(handler: (init: RequestInit, url: string) => Response): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(init ?? {}, url);
  };
}

describe("uriEncode", () => {
  it("编码保留字并保留路径分隔符", () => {
    expect(uriEncode("/a b/!c*")).toBe("/a%20b/%21c%2A");
  });

  it("encodeSlash 时编码斜杠", () => {
    expect(uriEncode("a/b", true)).toBe("a%2Fb");
  });
});

describe("SigV4 签名", () => {
  it("GET 请求签名与独立计算一致（虚拟主机样式）", async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    let capturedBody: BodyInit | null | undefined;
    const fetchImpl = captureFetch((init, url) => {
      capturedUrl = url;
      capturedAuth = String(new Headers(init.headers).get("authorization") ?? "");
      capturedBody = init.body;
      return new Response("<ListBucketResult></ListBucketResult>", { status: 200 });
    });
    const client = new S3CompatClient({
      endpoint: "https://s3.amazonaws.com",
      region: "us-east-1",
      bucket: "examplebucket",
      accessKeyId: testAccessKey,
      secretAccessKey: testSecretKey,
      fetchImpl,
      now: testClock
    });
    await client.listObjects("scriverse/img/");
    const url = new URL(capturedUrl);
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe("examplebucket.s3.amazonaws.com");
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("list-type")).toBe("2");
    expect(url.searchParams.get("prefix")).toBe("scriverse/img/");
    const amzDate = "20130524T000000Z";
    const payloadHash = sha256Hex("");
    const canonicalQuery = `list-type=2&prefix=${encodeURIComponent("scriverse/img/").replace(/%2F/giu, "%2F")}`;
    const signature = expectedSignature({
      method: "GET",
      path: "/",
      query: canonicalQuery,
      host: url.host,
      payload: Buffer.alloc(0),
      accessKeyId: testAccessKey,
      secretAccessKey: testSecretKey
    });
    expect(capturedAuth).toBe(
      `AWS4-HMAC-SHA256 Credential=${testAccessKey}/20130524/us-east-1/s3/aws4_request, `
      + "SignedHeaders=host;x-amz-content-sha256;x-amz-date, "
      + `Signature=${signature}`
    );
    expect(capturedBody).toBeUndefined();
  });

  it("PUT 请求签名与独立计算一致（路径样式）并携带内容类型", async () => {
    let captured: { url: string; auth: string; body: Uint8Array | null; contentType: string | null } | null = null;
    const fetchImpl = captureFetch((init, url) => {
      captured = {
        url,
        auth: String(new Headers(init.headers).get("authorization") ?? ""),
        body: init.body instanceof Uint8Array ? new Uint8Array(init.body) : null,
        contentType: String(new Headers(init.headers).get("content-type") ?? "")
      };
      return new Response("", { status: 200 });
    });
    const client = new S3CompatClient({
      endpoint: "http://127.0.0.1:9000",
      region: "us-east-1",
      bucket: "my-bucket",
      accessKeyId: testAccessKey,
      secretAccessKey: testSecretKey,
      fetchImpl,
      now: testClock
    });
    const payload = Buffer.from("hello backup");
    await client.putObject("scriverse/db/novel-20260802.db", payload, "application/octet-stream");
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("http://127.0.0.1:9000/my-bucket/scriverse/db/novel-20260802.db");
    expect(captured!.contentType).toBe("application/octet-stream");
    const url = new URL(captured!.url);
    const signature = expectedSignature({
      method: "PUT",
      path: url.pathname,
      query: "",
      host: url.host,
      payload,
      accessKeyId: testAccessKey,
      secretAccessKey: testSecretKey
    });
    expect(captured!.auth).toContain(`Signature=${signature}`);
  });

  it("含空格与中文的对象 key 签名与独立计算一致（不双重编码）", async () => {
    let captured: { url: string; auth: string } | null = null;
    const fetchImpl = captureFetch((init, url) => {
      captured = { url, auth: String(new Headers(init.headers).get("authorization") ?? "") };
      return new Response(null, { status: 200 });
    });
    const client = new S3CompatClient({
      endpoint: "https://s3.amazonaws.com",
      region: "us-east-1",
      bucket: "examplebucket",
      accessKeyId: testAccessKey,
      secretAccessKey: testSecretKey,
      fetchImpl,
      now: testClock
    });
    const key = "小说 备份/scriverse/db/novel-2026-08-02.db";
    await client.putObject(key, Buffer.from("data"));
    const url = new URL(captured!.url);
    // 实际请求路径为单次编码（路径分隔符保留）
    expect(url.pathname).toBe(`/${encodeURIComponent(key)}`.replace(/%2F/giu, "/"));
    // 期望签名基于解码后的原始路径做单次规范化编码，与客户端一致（不双重编码）
    const signature = expectedSignature({
      method: "PUT",
      path: uriEncode(decodeURIComponent(url.pathname)),
      query: "",
      host: url.host,
      payload: Buffer.from("data"),
      accessKeyId: testAccessKey,
      secretAccessKey: testSecretKey
    });
    expect(captured!.auth).toContain(`Signature=${signature}`);
  });

  it("DELETE 请求签名与独立计算一致", async () => {
    let captured: { url: string; auth: string } | null = null;
    const fetchImpl = captureFetch((init, url) => {
      captured = { url, auth: String(new Headers(init.headers).get("authorization") ?? "") };
      return new Response(null, { status: 204 });
    });
    const client = new S3CompatClient({
      endpoint: "https://s3.amazonaws.com",
      region: "us-east-1",
      bucket: "examplebucket",
      accessKeyId: testAccessKey,
      secretAccessKey: testSecretKey,
      fetchImpl,
      now: testClock
    });
    await client.deleteObject("scriverse/db/novel-old.db");
    const url = new URL(captured!.url);
    expect(url.host).toBe("examplebucket.s3.amazonaws.com");
    const signature = expectedSignature({
      method: "DELETE",
      path: url.pathname,
      query: "",
      host: url.host,
      payload: Buffer.alloc(0),
      accessKeyId: testAccessKey,
      secretAccessKey: testSecretKey
    });
    expect(captured!.auth).toContain(`Signature=${signature}`);
  });
});

describe("ListObjectsV2 响应解析", () => {
  it("解析对象列表与分页续传", async () => {
    const calls: string[] = [];
    const fetchImpl = captureFetch((_init, url) => {
      calls.push(url);
      if (calls.length === 1) {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
          <ListBucketResult>
            <IsTruncated>true</IsTruncated>
            <NextContinuationToken>token-1</NextContinuationToken>
            <Contents><Key>scriverse/img/ab/hash1.webp</Key><Size>123</Size><LastModified>2026-08-01T00:00:00.000Z</LastModified></Contents>
          </ListBucketResult>`,
          { status: 200 }
        );
      }
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
        <ListBucketResult>
          <IsTruncated>false</IsTruncated>
          <Contents><Key>scriverse/img/cd/hash2.png</Key><Size>456</Size><LastModified>2026-08-01T01:00:00.000Z</LastModified></Contents>
        </ListBucketResult>`,
        { status: 200 }
      );
    });
    const client = new S3CompatClient({
      endpoint: "https://s3.amazonaws.com",
      region: "us-east-1",
      bucket: "examplebucket",
      accessKeyId: testAccessKey,
      secretAccessKey: testSecretKey,
      fetchImpl,
      now: testClock
    });
    const objects = await client.listObjects("scriverse/img/");
    expect(objects).toHaveLength(2);
    expect(objects[0]?.key).toBe("scriverse/img/ab/hash1.webp");
    expect(objects[0]?.size).toBe(123);
    expect(objects[1]?.key).toBe("scriverse/img/cd/hash2.png");
    expect(calls[1]).toContain("continuation-token=token-1");
  });
});

describe("S3 错误解析", () => {
  it("解析 XML 错误并抛出 S3ServiceError", async () => {
    const fetchImpl = captureFetch(() => new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
      <Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message><RequestId>req-123</RequestId></Error>`,
      { status: 404 }
    ));
    const client = new S3CompatClient({
      endpoint: "https://s3.amazonaws.com",
      region: "us-east-1",
      bucket: "missing",
      accessKeyId: testAccessKey,
      secretAccessKey: testSecretKey,
      fetchImpl,
      now: testClock
    });
    await expect(client.listObjects("scriverse/")).rejects.toMatchObject({
      s3Status: 404,
      s3Code: "NoSuchBucket",
      s3RequestId: "req-123",
      message: expect.stringContaining("NoSuchBucket")
    });
  });

  it("网络错误转换为 S3ServiceError", async () => {
    const fetchImpl = captureFetch(() => {
      throw new Error("connection refused");
    });
    const client = new S3CompatClient({
      endpoint: "https://s3.amazonaws.com",
      region: "us-east-1",
      bucket: "examplebucket",
      accessKeyId: testAccessKey,
      secretAccessKey: testSecretKey,
      fetchImpl,
      now: testClock
    });
    await expect(client.putObject("scriverse/db/x.db", Buffer.from("x"))).rejects.toMatchObject({
      s3Status: 0,
      s3Code: "NETWORK_ERROR",
      message: expect.stringContaining("connection refused")
    });
  });
});

describe("contentTypeForStorageKey", () => {
  it("按扩展名返回内容类型", () => {
    expect(contentTypeForStorageKey("ab/hash.webp")).toBe("image/webp");
    expect(contentTypeForStorageKey("ab/hash.jpg")).toBe("image/jpeg");
    expect(contentTypeForStorageKey("ab/hash.png")).toBe("image/png");
    expect(contentTypeForStorageKey("novel-2026.db")).toBe("application/octet-stream");
  });
});

describe("客户端参数校验", () => {
  it("拒绝非 HTTP 端点、内嵌凭据与非法桶名", () => {
    const base = {
      region: "us-east-1",
      accessKeyId: testAccessKey,
      secretAccessKey: testSecretKey,
      now: testClock
    };
    expect(() => new S3CompatClient({ ...base, endpoint: "ftp://x", bucket: "b" })).toThrow("HTTP 或 HTTPS");
    expect(() => new S3CompatClient({ ...base, endpoint: "https://user:pass@x", bucket: "b" })).toThrow("内嵌账号");
    expect(() => new S3CompatClient({ ...base, endpoint: "https://x?q=1", bucket: "b" })).toThrow("查询参数");
    expect(() => new S3CompatClient({ ...base, endpoint: "https://x", bucket: "Bad Bucket" })).toThrow("桶名");
  });
});
