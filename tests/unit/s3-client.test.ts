import { describe, expect, it } from "vitest";
import { buildSignedRequest, createS3Client, S3Error } from "../../src/s3-client.js";

describe("s3-client: buildSignedRequest SigV4", () => {
  it("根据 AWS 文档示例生成正确签名（GET object）", () => {
    // AWS SigV4 test vector (simplified pseudo case)
    const fixedDate = new Date("2026-08-04T22:44:30.000Z");
    const signed = buildSignedRequest({
      endpoint: "https://examplebucket.s3.amazonaws.com",
      bucket: "examplebucket",
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      pathStyle: false,
      method: "GET",
      objectKey: "test.txt",
      headers: { "range": "bytes=0-9" },
      signingDate: fixedDate
    });
    const auth = signed.headers.authorization;
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/u);
    expect(signed.url).toBe("https://examplebucket.s3.amazonaws.com/test.txt");
  });

  it("path-style 模式 bucket 出现在路径首", () => {
    const signed = buildSignedRequest({
      endpoint: "https://s3.example.com",
      bucket: "mybucket",
      region: "us-east-1",
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      pathStyle: true,
      method: "PUT",
      objectKey: "x/y.txt",
      body: "hello",
      signingDate: new Date("2026-08-04T22:44:30.000Z")
    });
    expect(signed.url).toBe("https://s3.example.com/mybucket/x/y.txt");
    expect(signed.payloadHash.length).toBe(64);
  });

  it("host header 在 virtual-hosted 模式中包含 bucket", () => {
    const signed = buildSignedRequest({
      endpoint: "https://s3.example.com",
      bucket: "mybucket",
      region: "us-east-1",
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      pathStyle: false,
      method: "HEAD",
      objectKey: "x/y.txt",
      signingDate: new Date("2026-08-04T22:44:30.000Z")
    });
    expect(signed.headers.host).toBe("mybucket.s3.example.com");
  });

  it("x-amz-content-sha256 使用 UNSIGNED-PAYLOAD 当 body 为空", () => {
    const signed = buildSignedRequest({
      endpoint: "https://s3.example.com",
      bucket: "b",
      region: "us-east-1",
      accessKeyId: "a",
      secretAccessKey: "s",
      pathStyle: true,
      method: "HEAD",
      signingDate: new Date("2026-08-04T22:44:30.000Z")
    });
    expect(signed.headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
  });

  it("签名结果是确定的（同样的输入产生同样的输出）", () => {
    const date = new Date("2026-08-04T22:44:30.000Z");
    const params = {
      endpoint: "https://s3.example.com",
      bucket: "b",
      region: "us-east-1",
      accessKeyId: "a",
      secretAccessKey: "s",
      pathStyle: true,
      method: "GET" as const,
      objectKey: "k",
      signingDate: date
    };
    const first = buildSignedRequest(params);
    const second = buildSignedRequest(params);
    expect(first.headers.authorization).toBe(second.headers.authorization);
  });
});

describe("s3-client: 请求响应解析", () => {
  function jsonError(status: number, code: string, message: string): { status: number; headers: Record<string, string>; body: Buffer } {
    return {
      status,
      headers: { "x-amz-request-id": "REQ-1", "content-type": "application/xml" },
      body: Buffer.from(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`)
    };
  }

  it("putObject 出现服务端错误抛 S3Error", async () => {
    const s3 = createS3Client({
      endpoint: "https://s3.example.com",
      bucket: "b",
      region: "us-east-1",
      accessKeyId: "a",
      secretAccessKey: "s",
      pathStyle: true,
      fetchImpl: async (_url, _init) => jsonError(403, "AccessDenied", "权限不足")
    });
    await expect(s3.putObject({ key: "x", body: Buffer.from("data") })).rejects.toBeInstanceOf(S3Error);
    try {
      await s3.putObject({ key: "x", body: Buffer.from("data") });
    } catch (error) {
      if (error instanceof S3Error) {
        expect(error.code).toBe("AccessDenied");
        expect(error.status).toBe(403);
        expect(error.requestId).toBe("REQ-1");
      }
    }
  });

  it("headObject 404 返回 exists=false 而不抛错", async () => {
    const s3 = createS3Client({
      endpoint: "https://s3.example.com",
      bucket: "b",
      region: "us-east-1",
      accessKeyId: "a",
      secretAccessKey: "s",
      pathStyle: true,
      fetchImpl: async () => ({ status: 404, headers: {}, body: Buffer.from("") })
    });
    const result = await s3.headObject("missing-key");
    expect(result.exists).toBe(false);
  });

  it("listObjects 解析 XML 抓取 Key/Size/ETag", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Key>a.png</Key><Size>123</Size><ETag>"abc"</ETag><LastModified>2026-08-04T22:00:00Z</LastModified><Key>b.png</Key><Size>45</Size><ETag>"def"</ETag><LastModified>2026-08-04T22:10:00Z</LastModified><IsTruncated>false</IsTruncated></ListBucketResult>`;
    const s3 = createS3Client({
      endpoint: "https://s3.example.com",
      bucket: "b",
      region: "us-east-1",
      accessKeyId: "a",
      secretAccessKey: "s",
      pathStyle: true,
      fetchImpl: async () => ({ status: 200, headers: {}, body: Buffer.from(xml) })
    });
    const result = await s3.listObjects({ prefix: "scriverse/img/" });
    expect(result.objects).toEqual([
      { key: "a.png", size: 123, etag: '"abc"', lastModified: "2026-08-04T22:00:00Z" },
      { key: "b.png", size: 45, etag: '"def"', lastModified: "2026-08-04T22:10:00Z" }
    ]);
    expect(result.isTruncated).toBe(false);
  });

  it("deleteObjects 解析错误列表", async () => {
    const xml = `<?xml version="1.0"?><DeleteResult><Deleted><Key>a.png</Key></Deleted><Error><Key>b.png</Key><Code>AccessDenied</Code><Message>权限不足</Message></Error></DeleteResult>`;
    const s3 = createS3Client({
      endpoint: "https://s3.example.com",
      bucket: "b",
      region: "us-east-1",
      accessKeyId: "a",
      secretAccessKey: "s",
      pathStyle: true,
      fetchImpl: async () => ({ status: 200, headers: {}, body: Buffer.from(xml) })
    });
    const result = await s3.deleteObjects(["a.png", "b.png"]);
    expect(result.deleted).toEqual(["a.png"]);
    expect(result.errors[0]).toMatchObject({ key: "b.png", code: "AccessDenied" });
  });
});
