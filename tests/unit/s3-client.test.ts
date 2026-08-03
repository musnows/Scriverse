import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createS3Client, S3RequestError, type S3Target } from "../../src/s3-client.js";

type CapturedRequest = { method: string; url: string; headers: Record<string, string | undefined> };

function createMockS3Server(handler: (request: CapturedRequest, body: string) => { status: number; body: string }): Promise<{ server: Server; requests: CapturedRequest[]; baseUrl: string; close: () => Promise<void> }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const captured: CapturedRequest = {
        method: String(request.method),
        url: String(request.url),
        headers: request.headers as Record<string, string | undefined>
      };
      requests.push(captured);
      const result = handler(captured, body);
      response.statusCode = result.status;
      response.setHeader("Content-Type", "application/xml");
      response.end(result.body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;
      resolve({
        server,
        requests,
        baseUrl,
        close: () => new Promise<void>((done) => server.close(() => done()))
      });
    });
  });
}

function targetFor(baseUrl: string): S3Target {
  return {
    endpoint: baseUrl,
    region: "us-east-1",
    bucket: "backups",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    addressStyle: "path"
  };
}

describe("s3-client SigV4 请求构造", () => {
  let mock: Awaited<ReturnType<typeof createMockS3Server>>;
  beforeAll(async () => {
    mock = await createMockS3Server(() => ({ status: 200, body: "" }));
  });
  afterAll(async () => {
    await mock.close();
  });

  it("putObject 发送 path-style PUT 并携带 SigV4 头", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s3-put-"));
    const filePath = join(dir, "snapshot.db");
    writeFileSync(filePath, "db-content");
    try {
      await createS3Client(targetFor(mock.baseUrl)).putObject("scriverse/db/novel-1.db", filePath, "application/octet-stream");
      const request = mock.requests.find((item) => item.method === "PUT");
      expect(request).toBeDefined();
      expect(request?.url).toBe("/backups/scriverse/db/novel-1.db");
      expect(request?.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /u);
      expect(request?.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/u);
      expect(request?.headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("headObject 返回 true/false 并解析 404", async () => {
    const headMock = await createMockS3Server((request) => request.url?.includes("missing")
      ? { status: 404, body: "" }
      : { status: 200, body: "" });
    try {
      const client = createS3Client(targetFor(headMock.baseUrl));
      expect(await client.headObject("scriverse/img/exists.png")).toBe(true);
      expect(await client.headObject("scriverse/img/missing.png")).toBe(false);
    } finally {
      await headMock.close();
    }
  });

  it("listObjects 解析 ListBucketResult 的 Key", async () => {
    const listMock = await createMockS3Server(() => ({
      status: 200,
      body: `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Contents><Key>scriverse/img/a.png</Key></Contents><Contents><Key>scriverse/img/b.png</Key></Contents></ListBucketResult>`
    }));
    try {
      const keys = await createS3Client(targetFor(listMock.baseUrl)).listObjects("scriverse/img/");
      expect(keys).toEqual(["scriverse/img/a.png", "scriverse/img/b.png"]);
      const request = listMock.requests[0]!;
      expect(request.url).toContain("list-type=2");
      expect(request.url).toContain("prefix=scriverse%2Fimg%2F");
    } finally {
      await listMock.close();
    }
  });

  it("deleteObjects 发送 POST ?delete 并携带 Delete XML", async () => {
    const deleteMock = await createMockS3Server(() => ({ status: 200, body: "" }));
    try {
      await createS3Client(targetFor(deleteMock.baseUrl)).deleteObjects(["scriverse/db/novel-old.db"]);
      const request = deleteMock.requests.find((item) => item.method === "POST");
      expect(request).toBeDefined();
      expect(request?.url).toContain("delete=");
    } finally {
      await deleteMock.close();
    }
  });

  it("服务端错误返回 S3RequestError 并解析 Code/Message", async () => {
    const errorMock = await createMockS3Server(() => ({
      status: 403,
      body: `<Error><Code>AccessDenied</Code><Message>拒绝访问</Message></Error>`
    }));
    try {
      const client = createS3Client(targetFor(errorMock.baseUrl));
      let caught: unknown = null;
      try {
        await client.listObjects("scriverse/img/");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(S3RequestError);
      const s3Error = caught as S3RequestError;
      expect(s3Error.status).toBe(403);
      expect(s3Error.code).toBe("AccessDenied");
      expect(s3Error.serverMessage).toBe("拒绝访问");
    } finally {
      await errorMock.close();
    }
  });
});
