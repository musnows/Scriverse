import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3Client, S3RequestError } from "../../src/s3-client.js";
import { assertSafeBackupEndpoint, fetchSafeBackupEndpoint } from "../../src/security.js";

type ReceivedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  byteLength: number;
};

const received: ReceivedRequest[] = [];
const stored = new Map<string, Buffer>();
let server: Server;
let endpoint = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url ?? "/", endpoint || "http://127.0.0.1");
      received.push({
        method: String(request.method),
        url: String(request.url),
        headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, String(value)])),
        byteLength: body.byteLength
      });
      const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
      if (request.method === "PUT") {
        stored.set(key, body);
        response.writeHead(200).end();
        return;
      }
      if (request.method === "DELETE") {
        stored.delete(key);
        response.writeHead(204).end();
        return;
      }
      if (url.pathname.startsWith("/forbidden-bucket")) {
        response.writeHead(403, { "content-type": "application/xml", "x-amz-request-id": "REQ-403" })
          .end("<Error><Code>AccessDenied</Code><Message>没有访问该桶的权限</Message><RequestId>REQ-403</RequestId></Error>");
        return;
      }
      if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const contents = [...stored.entries()]
          .filter(([storedKey]) => storedKey.startsWith(prefix))
          .map(([storedKey, value]) => `<Contents><Key>${storedKey}</Key><Size>${value.byteLength}</Size><LastModified>2026-08-04T00:00:00.000Z</LastModified></Contents>`)
          .join("");
        response.writeHead(200, { "content-type": "application/xml" })
          .end(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
        return;
      }
      response.writeHead(403, { "content-type": "application/xml" })
        .end("<Error><Code>AccessDenied</Code><Message>拒绝访问</Message><RequestId>REQ-T</RequestId></Error>");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function createClient(): S3Client {
  return new S3Client(
    { endpoint, region: "us-east-1", bucket: "novel-backup", prefix: "team/alpha", forcePathStyle: true },
    { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
    (url, init) => fetchSafeBackupEndpoint(fetch, url, init, (target) => assertSafeBackupEndpoint(target, true))
  );
}

describe("S3 备份出站请求（真实 HTTP 与 SSRF 地址锁定）", () => {
  it("通过地址锁定的出站通道上传对象，且不手工设置 content-length", async () => {
    const body = Buffer.alloc(512 * 1024, 7);
    await createClient().putObject("team/alpha/scriverse/db/novel-20260804T000000Z.db", body, "application/vnd.sqlite3");

    const put = received.find((item) => item.method === "PUT");
    expect(put?.byteLength).toBe(body.byteLength);
    expect(put?.headers["content-length"]).toBe(String(body.byteLength));
    expect(put?.headers.authorization).toContain("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/");
    // content-length 由 HTTP 层补齐，不能出现在签名头列表里。
    expect(put?.headers.authorization).toContain("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date");
    expect(put?.headers["x-amz-content-sha256"]).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored.get("team/alpha/scriverse/db/novel-20260804T000000Z.db")?.byteLength).toBe(body.byteLength);
  });

  it("列举与删除都能通过真实 HTTP 完成", async () => {
    const client = createClient();
    const objects = await client.listObjects("team/alpha/scriverse/db/");
    expect(objects.map((object) => object.key)).toContain("team/alpha/scriverse/db/novel-20260804T000000Z.db");

    await client.deleteObject("team/alpha/scriverse/db/novel-20260804T000000Z.db");
    expect(stored.has("team/alpha/scriverse/db/novel-20260804T000000Z.db")).toBe(false);
  });

  it("服务端返回错误时保留状态码与 XML 正文", async () => {
    const client = new S3Client(
      { endpoint, region: "us-east-1", bucket: "forbidden-bucket", prefix: "", forcePathStyle: true },
      { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      (url, init) => fetchSafeBackupEndpoint(fetch, url, init, (target) => assertSafeBackupEndpoint(target, true))
    );
    const failure = await client.probe().then(() => null, (error: unknown) => (error as S3RequestError).detail);
    expect(failure).toMatchObject({
      httpStatus: 403,
      s3Code: "AccessDenied",
      s3Message: "没有访问该桶的权限",
      s3RequestId: "REQ-403"
    });
    expect(String(failure?.responseBody)).toContain("<Code>AccessDenied</Code>");

    // 删除不存在的对象按成功处理，避免留存清理因竞态反复失败。
    await expect(createClient().deleteObject("team/alpha/scriverse/db/missing.db", 5_000)).resolves.toBeUndefined();
  });

  it("拒绝指向受保护网络的备份地址", async () => {
    await expect(assertSafeBackupEndpoint("http://169.254.169.254/latest/meta-data", true))
      .rejects.toMatchObject({ code: "UNSAFE_BACKUP_ENDPOINT" });
    await expect(assertSafeBackupEndpoint("http://127.0.0.1:9000", false))
      .rejects.toMatchObject({ code: "UNSAFE_BACKUP_ENDPOINT" });
    await expect(assertSafeBackupEndpoint("ftp://example.com", true))
      .rejects.toMatchObject({ code: "UNSAFE_BACKUP_ENDPOINT" });
    await expect(assertSafeBackupEndpoint("https://user:pass@example.com", true))
      .rejects.toMatchObject({ code: "UNSAFE_BACKUP_ENDPOINT" });
  });
});
