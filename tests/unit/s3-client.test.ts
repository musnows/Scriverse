import { describe, expect, it, vi } from "vitest";
import { S3Client, S3RequestError, type S3ObjectInfo } from "../../src/s3-client.js";

type RecordedCall = { method: string; url: string; headers: Record<string, string>; body?: Buffer };

function createMockFetch(handler: (method: string, url: string, headers: Record<string, string>, body?: Buffer) => Response) {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn(async (input: any, init?: any): Promise<Response> => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) for (const [key, value] of Object.entries(init.headers)) headers[key] = String(value);
    const body = init?.body as Buffer | undefined;
    calls.push({ method, url, headers, body });
    return handler(method, url, headers, body);
  });
  return { fetchImpl, calls };
}

function listingXml(keys: string[], truncated: boolean, token: string | null): string {
  const contents = keys
    .map((key) => `<Contents><Key>${key}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>${truncated}</IsTruncated>${
    token ? `<NextContinuationToken>${token}</NextContinuationToken>` : ""
  }${contents}</ListBucketResult>`;
}

const options = {
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "my-bucket",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "SECRETEXAMPLE"
};

describe("S3Client SigV4 与对象操作", () => {
  it("putObject 发送带签名的 PUT 请求，路径为 path-style", async () => {
    const { fetchImpl, calls } = createMockFetch(() => new Response(null, { status: 200 }));
    const client = new S3Client(options, fetchImpl as unknown as typeof fetch);
    await client.putObject("scriverse/db/novel-20260801.db", Buffer.from("db-bytes"), "application/octet-stream");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toBe("https://s3.example.com/my-bucket/scriverse/db/novel-20260801.db");
    const auth = calls[0].headers["Authorization"];
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request/);
    expect(auth).toContain("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date");
    expect(calls[0].headers["x-amz-content-sha256"]).toBeDefined();
    expect(calls[0].headers["x-amz-date"]).toBeDefined();
  });

  it("headObject 在 200 时返回 true、404 时返回 false、其余状态抛错", async () => {
    const { fetchImpl } = createMockFetch((method, _url, _headers, _body) => {
      if (method === "HEAD") return new Response(null, { status: 404 });
      return new Response(null, { status: 200 });
    });
    const client = new S3Client(options, fetchImpl as unknown as typeof fetch);
    expect(await client.headObject("scriverse/img/a.png")).toBe(false);

    const { fetchImpl: fetchImpl2 } = createMockFetch((method) => new Response(null, {
      status: method === "HEAD" ? 200 : 500
    }));
    const client2 = new S3Client(options, fetchImpl2 as unknown as typeof fetch);
    expect(await client2.headObject("scriverse/img/a.png")).toBe(true);

    const { fetchImpl: fetchImpl3 } = createMockFetch((method) => new Response("AccessDenied", {
      status: method === "HEAD" ? 403 : 500
    }));
    const client3 = new S3Client(options, fetchImpl3 as unknown as typeof fetch);
    await expect(client3.headObject("scriverse/img/a.png")).rejects.toBeInstanceOf(S3RequestError);
  });

  it("listObjects 解析结果并处理翻页", async () => {
    let first = true;
    const { fetchImpl, calls } = createMockFetch((_method, url) => {
      if (url.includes("continuation-token=page2")) {
        return new Response(listingXml(["scriverse/db/c.db"], false, null), { status: 200 });
      }
      if (first) {
        first = false;
        return new Response(listingXml(["scriverse/db/a.db", "scriverse/db/b.db"], true, "page2"), { status: 200 });
      }
      return new Response(listingXml([], false, null), { status: 200 });
    });
    const client = new S3Client(options, fetchImpl as unknown as typeof fetch);
    const objects: S3ObjectInfo[] = await client.listObjects("scriverse/db/");
    expect(objects.map((object) => object.key)).toEqual(["scriverse/db/a.db", "scriverse/db/b.db", "scriverse/db/c.db"]);
    const listCalls = calls.filter((call) => call.method === "GET" && call.url.includes("list-type=2"));
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1].url).toContain("continuation-token=page2");
  });

  it("deleteObject 发送 DELETE 请求", async () => {
    const { fetchImpl, calls } = createMockFetch(() => new Response(null, { status: 200 }));
    const client = new S3Client(options, fetchImpl as unknown as typeof fetch);
    await client.deleteObject("scriverse/db/old.db");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("https://s3.example.com/my-bucket/scriverse/db/old.db");
  });

  it("非 2xx 响应抛出包含状态码与服务端正文的 S3RequestError", async () => {
    const { fetchImpl } = createMockFetch(() => new Response("<Error><Message>AccessDenied</Message></Error>", {
      status: 403
    }));
    const client = new S3Client(options, fetchImpl as unknown as typeof fetch);
    try {
      await client.putObject("scriverse/db/x.db", Buffer.from("x"));
      expect.unreachable("应当抛出 S3RequestError");
    } catch (error) {
      expect(error).toBeInstanceOf(S3RequestError);
      expect((error as S3RequestError).status).toBe(403);
      expect((error as S3RequestError).body).toContain("AccessDenied");
    }
  });
});
