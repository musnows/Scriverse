import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createAwsV4Authorization,
  formatBackupTimestamp,
  normalizeBackupEndpoint,
  normalizeBackupPrefix,
  S3Client,
  S3RequestError,
  shouldTriggerScheduledBackup
} from "../../src/s3-backup.js";
import { AppError } from "../../src/errors.js";

const testTarget = {
  endpoint: "http://127.0.0.1:19000",
  region: "us-east-1",
  bucket: "backup-bucket",
  accessKeyId: "AKIATESTKEY123",
  secretAccessKey: "test-secret-key-for-sigv4-verification-0123456789"
};

describe("备份工具函数", () => {
  it("formatBackupTimestamp 输出本地时间 YYYYMMDD-HHmmss", () => {
    expect(formatBackupTimestamp(new Date(2026, 7, 13, 3, 0, 5))).toBe("20260813-030005");
    expect(formatBackupTimestamp(new Date(2026, 0, 2, 23, 59, 59))).toBe("20260102-235959");
  });

  it("normalizeBackupPrefix 去掉首尾斜杠与空白", () => {
    expect(normalizeBackupPrefix("  my-backup/novel/  ")).toBe("my-backup/novel");
    expect(normalizeBackupPrefix("/leading/trailing/")).toBe("leading/trailing");
    expect(normalizeBackupPrefix("   ")).toBe("");
  });

  it("normalizeBackupEndpoint 补全协议并去掉尾部斜杠", () => {
    expect(normalizeBackupEndpoint("https://s3.example.com/")).toBe("https://s3.example.com");
    expect(normalizeBackupEndpoint("minio.local:9000")).toBe("https://minio.local:9000");
    expect(normalizeBackupEndpoint("http://127.0.0.1:19000//")).toBe("http://127.0.0.1:19000");
  });

  it("shouldTriggerScheduledBackup 只在设定时刻且同一天触发一次", () => {
    const settings = { scheduleEnabled: true, scheduleTime: "03:00" };
    expect(shouldTriggerScheduledBackup(settings, new Date(2026, 7, 13, 3, 0, 30), "")).toBe(true);
    expect(shouldTriggerScheduledBackup(settings, new Date(2026, 7, 13, 3, 0, 30), "2026-8-13")).toBe(false);
    expect(shouldTriggerScheduledBackup(settings, new Date(2026, 7, 13, 3, 1, 0), "")).toBe(false);
    expect(shouldTriggerScheduledBackup({ scheduleEnabled: true, scheduleTime: "03:00" }, new Date(2026, 7, 14, 3, 0, 0), "2026-8-13")).toBe(true);
    expect(shouldTriggerScheduledBackup({ scheduleEnabled: false, scheduleTime: "03:00" }, new Date(2026, 7, 13, 3, 0, 0), "")).toBe(false);
    expect(shouldTriggerScheduledBackup({ scheduleEnabled: true, scheduleTime: "" }, new Date(2026, 7, 13, 3, 0, 0), "")).toBe(false);
  });
});

describe("createAwsV4Authorization 签名", () => {
  it("PUT 请求签名与独立实现一致", () => {
    const url = new URL("http://127.0.0.1:19000/bucket/scriverse/db/novel-20260813-030000.db");
    const payloadHash = createHash("sha256").update("snapshot-bytes").digest("hex");
    const authorization = createAwsV4Authorization({
      method: "PUT",
      url,
      payloadHash,
      contentType: "application/x-sqlite3",
      accessKeyId: testTarget.accessKeyId,
      secretAccessKey: testTarget.secretAccessKey,
      region: "us-east-1",
      timestamp: "20260813T030000Z"
    });
    expect(authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIATESTKEY123/20260813/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;content-type, Signature=5491543a84c03e30aad248b2d92d9bbbc5f3183ed2016b7cc0d05f8902607835"
    );
  });

  it("GET 列表请求签名与独立实现一致", () => {
    const url = new URL("https://bucket.s3.amazonaws.com/?list-type=2&prefix=scriverse%2Fdb%2F");
    const authorization = createAwsV4Authorization({
      method: "GET",
      url,
      payloadHash: "UNSIGNED-PAYLOAD",
      accessKeyId: testTarget.accessKeyId,
      secretAccessKey: testTarget.secretAccessKey,
      region: "cn-north-1",
      timestamp: "20260813T030100Z"
    });
    expect(authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIATESTKEY123/20260813/cn-north-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=9922943be29d31063922dca428a78ea0cc5e0ad93287114477c8bf6e679262b4"
    );
  });
});

function xmlListResponse(keys: string[], options: { truncated?: boolean; continuationToken?: string } = {}): string {
  const contents = keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>${options.truncated === true ? "true" : "false"}</IsTruncated>
  ${options.continuationToken ? `<NextContinuationToken>${options.continuationToken}</NextContinuationToken>` : ""}
  ${contents}
</ListBucketResult>`;
}

function xmlErrorResponse(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message><RequestId>req-123</RequestId></Error>`;
}

describe("S3Client 请求构造", () => {
  it("非 AWS 域名使用路径风格 URL，并携带正确的签名头", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const client = new S3Client(testTarget, fetchMock);
    await client.putObject("scriverse/db/novel-20260813-030000.db", Buffer.from("snapshot"), "application/x-sqlite3");
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(input));
    expect(url.host).toBe("127.0.0.1:19000");
    expect(url.pathname).toBe("/backup-bucket/scriverse/db/novel-20260813-030000.db");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATESTKEY123\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=/u);
    expect(headers["x-amz-content-sha256"]).toBe(createHash("sha256").update("snapshot").digest("hex"));
    expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/u);
    expect(headers["content-type"]).toBe("application/x-sqlite3");
    expect((init as RequestInit).redirect).toBe("manual");
  });

  it("AWS 官方域名使用虚拟主机风格 URL", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const client = new S3Client({ ...testTarget, endpoint: "https://s3.amazonaws.com" }, fetchMock);
    await client.putObject("scriverse/db/novel-20260813-030000.db", Buffer.from("snapshot"), "application/x-sqlite3");
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.host).toBe("backup-bucket.s3.amazonaws.com");
    expect(url.pathname).toBe("/scriverse/db/novel-20260813-030000.db");
  });

  it("对象键按路径段编码，保留 / 分隔符", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const client = new S3Client(testTarget, fetchMock);
    await client.putObject("scriverse/img/中文 目录/图 片.webp", Buffer.from("img"), "image/webp");
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(`/backup-bucket/scriverse/img/${encodeURIComponent("中文 目录")}/${encodeURIComponent("图 片.webp")}`);
  });
});

describe("S3Client 列表与错误处理", () => {
  it("listObjectKeys 解析 XML 并跟随分页", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(xmlListResponse(["scriverse/db/novel-20260810-030000.db"], { truncated: true, continuationToken: "page-2" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(xmlListResponse(["scriverse/db/novel-20260813-030000.db", "scriverse/db/note.txt"], { truncated: false }), { status: 200 }));
    const client = new S3Client(testTarget, fetchMock);
    const keys = await client.listObjectKeys("scriverse/db/");
    expect(keys).toEqual([
      "scriverse/db/novel-20260810-030000.db",
      "scriverse/db/novel-20260813-030000.db",
      "scriverse/db/note.txt"
    ]);
    const secondUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(secondUrl.searchParams.get("continuation-token")).toBe("page-2");
    expect(secondUrl.searchParams.get("list-type")).toBe("2");
  });

  it("分页结果缺少 continuation token 时拒绝", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(xmlListResponse(["k"], { truncated: true }), { status: 200 }));
    const client = new S3Client(testTarget, fetchMock);
    await expect(client.listObjectKeys("p/")).rejects.toThrow("分页结果");
  });

  it("非 2xx 响应抛出携带完整服务端返回的 S3RequestError", async () => {
    const body = xmlErrorResponse("AccessDenied", "Access Denied for bucket backup-bucket");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(body, { status: 403 }));
    const client = new S3Client(testTarget, fetchMock);
    await expect(client.putObject("scriverse/db/novel-1.db", Buffer.from("x"))).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(S3RequestError);
      const s3Error = error as S3RequestError;
      expect(s3Error.statusCode).toBe(403);
      expect(s3Error.code).toBe("AccessDenied");
      expect(s3Error.s3Message).toBe("Access Denied for bucket backup-bucket");
      expect(s3Error.message).toContain("HTTP 403");
      expect(s3Error.responseBody).toBe(body);
      expect(s3Error.method).toBe("PUT");
      expect(s3Error.key).toBe("scriverse/db/novel-1.db");
      return true;
    });
  });

  it("DELETE 对 404 视为已删除", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    const client = new S3Client(testTarget, fetchMock);
    await expect(client.deleteObject("scriverse/db/old.db")).resolves.toBeUndefined();
  });

  it("拒绝跨域重定向", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 301, headers: { location: "https://evil.example.com/steal" } }));
    const client = new S3Client(testTarget, fetchMock);
    await expect(client.putObject("k", Buffer.from("x"))).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("BACKUP_S3_REDIRECT_CROSS_ORIGIN");
      return true;
    });
  });

  it("跟随同源 307 重定向并保留请求体", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/backup-bucket/final-location" } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const client = new S3Client(testTarget, fetchMock);
    await client.putObject("scriverse/db/novel-1.db", Buffer.from("snapshot"), "application/x-sqlite3");
    const finalUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(finalUrl.pathname).toBe("/backup-bucket/final-location");
    const finalInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(finalInit.method).toBe("PUT");
    expect(finalInit.body).toBeInstanceOf(Uint8Array);
  });
});
