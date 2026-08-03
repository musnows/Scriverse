import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { S3Client, type S3TargetConfig } from "../../src/s3-client.js";

const baseConfig: S3TargetConfig = {
  id: "target_test", name: "测试目标",
  endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1",
  bucket: "examplebucket", subdirectory: "",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  forcePathStyle: true
};
const fixedDate = new Date("2026-08-03T03:30:00.000Z");

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function referenceSignature(config: S3TargetConfig, method: string, path: string, query: Array<[string, string]>, host: string, body: Buffer | null, date: Date, extraHeaders: Record<string, string> = {}): string {
  const dateTime = date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  const dateStamp = dateTime.slice(0, 8);
  const region = config.region || "us-east-1";
  const payloadHash = body ? sha256Hex(body) : sha256Hex("");
  const allHeaders: Record<string, string> = { ...extraHeaders, host, "x-amz-date": dateTime, "x-amz-content-sha256": payloadHash };
  const canonicalHeaders = Object.entries(allHeaders)
    .map(([name, value]) => [name.toLocaleLowerCase(), value.trim().replace(/\s+/gu, " ")] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeadersString = canonicalHeaders.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaders = canonicalHeaders.map(([name]) => name).join(";");
  const encode = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/gu, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const canonicalUri = encode(path).replace(/%2F/giu, "/");
  const canonicalQuery = [...query]
    .map(([name, value]) => [encode(name), encode(value)] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`).join("&");
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeadersString, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", dateTime, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const dateKey = createHmac("sha256", `AWS4${config.secretAccessKey}`).update(dateStamp).digest();
  const dateRegionKey = createHmac("sha256", dateKey).update(region).digest();
  const dateRegionServiceKey = createHmac("sha256", dateRegionKey).update("s3").digest();
  const signingKey = createHmac("sha256", dateRegionServiceKey).update("aws4_request").digest();
  return createHmac("sha256", signingKey).update(stringToSign).digest("hex");
}

function createMockFetch(capture: { headers: Record<string, string>; url: string; method: string }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture.url = String(url);
    capture.method = String(init?.method ?? "GET");
    capture.headers = init?.headers as Record<string, string> ?? {};
    return new Response("", { status: 200, headers: { "content-length": "0" } });
  }) as unknown as typeof fetch;
}

describe("S3 SigV4 签名", () => {
  it("PutObject 生成与参考实现一致的签名", async () => {
    const capture: { headers: Record<string, string>; url: string; method: string } = { headers: {}, url: "", method: "" };
    const client = new S3Client({ fetchImpl: createMockFetch(capture), now: () => fixedDate });
    const body = Buffer.from("hello world");
    await client.putObject(baseConfig, "scriverse/db/test.db", body, "application/octet-stream");
    const auth = capture.headers.authorization;
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260803\/us-east-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/u);
    const expected = referenceSignature(baseConfig, "PUT", "/examplebucket/scriverse/db/test.db", [], "s3.us-east-1.amazonaws.com", body, fixedDate, { "content-type": "application/octet-stream" });
    expect(auth).toContain(`Signature=${expected}`);
  });

  it("HeadObject 生成与参考实现一致的签名", async () => {
    const capture: { headers: Record<string, string>; url: string; method: string } = { headers: {}, url: "", method: "" };
    const client = new S3Client({ fetchImpl: createMockFetch(capture), now: () => fixedDate });
    const exists = await client.headObject(baseConfig, "scriverse/img/ab/abcdef.png");
    expect(exists).toBe(true);
    expect(capture.method).toBe("HEAD");
    const expected = referenceSignature(baseConfig, "HEAD", "/examplebucket/scriverse/img/ab/abcdef.png", [], "s3.us-east-1.amazonaws.com", null, fixedDate);
    expect(capture.headers.authorization).toContain(`Signature=${expected}`);
  });

  it("ListObjects 包含查询字符串并正确签名", async () => {
    const capture: { headers: Record<string, string>; url: string; method: string } = { headers: {}, url: "", method: "" };
    const client = new S3Client({ fetchImpl: createMockFetch(capture), now: () => fixedDate });
    await client.listObjects(baseConfig, "scriverse/db/", null);
    expect(capture.url).toContain("list-type=2");
    expect(capture.url).toContain("prefix=scriverse%2Fdb%2F");
    const query: Array<[string, string]> = [["list-type", "2"], ["prefix", "scriverse/db/"]];
    const expected = referenceSignature(baseConfig, "GET", "/examplebucket/", query, "s3.us-east-1.amazonaws.com", null, fixedDate);
    expect(capture.headers.authorization).toContain(`Signature=${expected}`);
  });

  it("虚拟主机风格使用 bucket 前缀主机名", async () => {
    const virtualConfig: S3TargetConfig = { ...baseConfig, forcePathStyle: false };
    const capture: { headers: Record<string, string>; url: string; method: string } = { headers: {}, url: "", method: "" };
    const client = new S3Client({ fetchImpl: createMockFetch(capture), now: () => fixedDate });
    await client.headObject(virtualConfig, "scriverse/img/ab/abcdef.png");
    expect(capture.url).toContain("examplebucket.s3.us-east-1.amazonaws.com");
    expect(capture.headers.host).toBe("examplebucket.s3.us-east-1.amazonaws.com");
    const expected = referenceSignature(virtualConfig, "HEAD", "/scriverse/img/ab/abcdef.png", [], "examplebucket.s3.us-east-1.amazonaws.com", null, fixedDate);
    expect(capture.headers.authorization).toContain(`Signature=${expected}`);
  });

  it("HeadObject 404 返回 false", async () => {
    const mockFetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const client = new S3Client({ fetchImpl: mockFetch, now: () => fixedDate });
    expect(await client.headObject(baseConfig, "missing")).toBe(false);
  });

  it("服务端错误抛出 S3RequestError 并携带响应详情", async () => {
    const errorBody = "<?xml version=\"1.0\"?><Error><Code>NoSuchBucket</Code><Message>The bucket does not exist</Message></Error>";
    const mockFetch = (async () => new Response(errorBody, { status: 404, headers: { "x-amz-request-id": "abc123" } })) as unknown as typeof fetch;
    const client = new S3Client({ fetchImpl: mockFetch, now: () => fixedDate });
    await expect(client.putObject(baseConfig, "key", Buffer.from("data"), "application/octet-stream")).rejects.toMatchObject({
      name: "S3RequestError",
      status: 404,
      responseBody: errorBody
    });
  });
});
