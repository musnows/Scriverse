import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  S3Client,
  S3RequestError,
  parseListObjectsV2,
  sigV4Signature,
  type S3ClientOptions
} from "../../src/s3-client.js";

const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("SigV4 签名", () => {
  it("通过 AWS 官方文档示例（IAM ListUsers）", () => {
    const signature = sigV4Signature({
      method: "GET",
      canonicalUri: "/",
      canonicalQuery: "Action=ListUsers&Version=2010-05-08",
      headers: [
        ["content-type", "application/x-www-form-urlencoded; charset=utf-8"],
        ["host", "iam.amazonaws.com"],
        ["x-amz-date", "20150830T123600Z"]
      ],
      payloadHashHex: EMPTY_PAYLOAD_SHA256,
      region: "us-east-1",
      service: "iam",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      amzDate: "20150830T123600Z",
      dateStamp: "20150830"
    });
    expect(signature).toBe("5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
  });
});

describe("ListObjectsV2 XML 解析", () => {
  it("解析单页多个 key", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>backups</Name>
  <Prefix>scriverse/db/</Prefix>
  <IsTruncated>false</IsTruncated>
  <Contents><Key>scriverse/db/scriverse-20260801-000000.db</Key></Contents>
  <Contents><Key>scriverse/db/scriverse-20260802-000000.db</Key></Contents>
</ListBucketResult>`;
    expect(parseListObjectsV2(xml)).toEqual({
      keys: ["scriverse/db/scriverse-20260801-000000.db", "scriverse/db/scriverse-20260802-000000.db"],
      isTruncated: false,
      nextContinuationToken: null
    });
  });

  it("解析截断页和 continuation token", () => {
    const xml = "<ListBucketResult>"
      + "<IsTruncated>true</IsTruncated>"
      + "<NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=</NextContinuationToken>"
      + "<Contents><Key>scriverse/db/a.db</Key></Contents>"
      + "</ListBucketResult>";
    const page = parseListObjectsV2(xml);
    expect(page.isTruncated).toBe(true);
    expect(page.nextContinuationToken).toBe("1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=");
    expect(page.keys).toEqual(["scriverse/db/a.db"]);
  });

  it("对 key 文本做 XML 实体解码，&amp; 最后处理", () => {
    const xml = "<ListBucketResult><IsTruncated>false</IsTruncated>"
      + "<Contents><Key>a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;.db</Key></Contents>"
      + "<Contents><Key>x &amp;lt; y.db</Key></Contents>"
      + "</ListBucketResult>";
    expect(parseListObjectsV2(xml).keys).toEqual(["a & b <c> \"d\" 'e'.db", "x &lt; y.db"]);
  });
});

type CapturedRequest = { url: string; method: string; headers: Headers };

function captureFetch(responses: Array<() => Response>): { fetchImpl: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const responder = responses[calls.length];
    if (!responder) throw new Error("测试出现了计划外的额外请求");
    calls.push({ url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers) });
    return responder();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function createClient(overrides: Partial<S3ClientOptions> = {}): S3Client {
  return new S3Client({
    endpointUrl: "https://s3.us-east-1.amazonaws.com",
    region: "us-east-1",
    bucket: "backups",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    forcePathStyle: false,
    fetchImpl: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    validateOutboundUrl: undefined,
    ...overrides
  });
}

describe("S3 对象 URL 构造", () => {
  it("virtual-host 风格把桶名前置到 host", () => {
    expect(createClient().objectUrl("scriverse/db/a.db")).toBe("https://backups.s3.us-east-1.amazonaws.com/scriverse/db/a.db");
  });

  it("path 风格把桶名放进路径，并保留端点自带的 path 段", () => {
    const client = createClient({ endpointUrl: "https://minio.example.com:9000/gateway", forcePathStyle: true });
    expect(client.objectUrl("scriverse/db/a.db")).toBe("https://minio.example.com:9000/gateway/backups/scriverse/db/a.db");
  });

  it("对 key 的每个路径段做 RFC3986 编码并保留段间斜杠", () => {
    expect(createClient().objectUrl("a b/c#d.db")).toBe("https://backups.s3.us-east-1.amazonaws.com/a%20b/c%23d.db");
  });

  it("拒绝带查询串的端点地址", () => {
    expect(() => createClient({ endpointUrl: "https://s3.example.com/?x=1" })).toThrowError(/查询串/u);
  });
});

describe("S3Client 请求行为", () => {
  it("putObject 发送带 SigV4 签名头的 PUT 请求", async () => {
    const { fetchImpl, calls } = captureFetch([() => new Response(null, { status: 200 })]);
    const client = createClient({ fetchImpl, forcePathStyle: true, endpointUrl: "https://minio.example.com:9000" });
    const body = new TextEncoder().encode("db-bytes");
    await client.putObject("scriverse/db/a.db", body, "application/octet-stream");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.method).toBe("PUT");
    expect(call?.url).toBe("https://minio.example.com:9000/backups/scriverse/db/a.db");
    const authorization = call?.headers.get("authorization") ?? "";
    expect(authorization.startsWith("AWS4-HMAC-SHA256 ")).toBe(true);
    expect(authorization).toContain("Credential=AKIDEXAMPLE/");
    expect(authorization).toContain("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date");
    expect(call?.headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/u);
    expect(call?.headers.get("x-amz-content-sha256")).toBe(createHash("sha256").update(body).digest("hex"));
    expect(call?.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("listKeys 自动翻页并在后续请求携带 continuation-token", async () => {
    const firstPage = "<ListBucketResult>"
      + "<IsTruncated>true</IsTruncated>"
      + "<NextContinuationToken>token/1+2=</NextContinuationToken>"
      + "<Contents><Key>scriverse/db/a.db</Key></Contents>"
      + "</ListBucketResult>";
    const secondPage = "<ListBucketResult>"
      + "<IsTruncated>false</IsTruncated>"
      + "<Contents><Key>scriverse/db/b.db</Key></Contents>"
      + "</ListBucketResult>";
    const { fetchImpl, calls } = captureFetch([
      () => new Response(firstPage, { status: 200 }),
      () => new Response(secondPage, { status: 200 })
    ]);
    const client = createClient({ fetchImpl });
    const keys = await client.listKeys("scriverse/db/");
    expect(keys).toEqual(["scriverse/db/a.db", "scriverse/db/b.db"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url.startsWith("https://backups.s3.us-east-1.amazonaws.com/?")).toBe(true);
    expect(calls[0]?.url).toContain("list-type=2");
    expect(calls[0]?.url).toContain("prefix=scriverse%2Fdb%2F");
    expect(calls[0]?.url).not.toContain("continuation-token");
    expect(calls[1]?.url).toContain("continuation-token=token%2F1%2B2%3D");
  });

  it("deleteObject 发送 DELETE 请求，空正文 hash 参与签名", async () => {
    const { fetchImpl, calls } = captureFetch([() => new Response(null, { status: 204 })]);
    const client = createClient({ fetchImpl });
    await client.deleteObject("scriverse/db/a.db");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.headers.get("x-amz-content-sha256")).toBe(EMPTY_PAYLOAD_SHA256);
    expect(calls[0]?.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 ")).toBe(true);
  });

  it("非 2xx 响应抛 S3RequestError 并保留服务端文本，不泄露凭据", async () => {
    const body = "<Error><Code>AccessDenied</Code><Message>denied</Message></Error>";
    const { fetchImpl } = captureFetch([() => new Response(body, { status: 403 })]);
    const client = createClient({ fetchImpl });
    const error: unknown = await client.deleteObject("scriverse/db/a.db").then(
      () => {
        throw new Error("应当抛出 S3RequestError");
      },
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(S3RequestError);
    const requestError = error as S3RequestError;
    expect(requestError.status).toBe(403);
    expect(requestError.responseBody).toContain("AccessDenied");
    expect(requestError.message).toContain("HTTP 403");
    expect(requestError.message).not.toContain("wJalrXUtnFEMI");
    expect(requestError.message).not.toContain("AKIDEXAMPLE");
  });
});
