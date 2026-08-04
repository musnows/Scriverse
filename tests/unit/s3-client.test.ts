import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors.js";
import {
  backupDatabasePrefix,
  backupImagePrefix,
  buildBackupObjectKey,
  formatAmazonDateTime,
  normalizeBackupPrefix,
  parseListObjectsPayload,
  parseS3ErrorPayload,
  signAwsV4Request,
  uriEncodeComponent
} from "../../src/s3-client.js";

const exampleCredentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
};

/** 按 AWS 文档的密钥派生步骤独立计算签名，用于校验实现而不复制实现代码。 */
function referenceSignature(canonicalRequestSha256: string, options: {
  amazonDateTime: string;
  region: string;
  service: string;
  secretAccessKey: string;
}): string {
  const date = options.amazonDateTime.slice(0, 8);
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    options.amazonDateTime,
    `${date}/${options.region}/${options.service}/aws4_request`,
    canonicalRequestSha256
  ].join("\n");
  const dateKey = createHmac("sha256", `AWS4${options.secretAccessKey}`).update(date).digest();
  const regionKey = createHmac("sha256", dateKey).update(options.region).digest();
  const serviceKey = createHmac("sha256", regionKey).update(options.service).digest();
  const signingKey = createHmac("sha256", serviceKey).update("aws4_request").digest();
  return createHmac("sha256", signingKey).update(stringToSign).digest("hex");
}

describe("AWS Signature V4 签名", () => {
  it("对 S3 GET Object 复现 AWS 文档给出的规范请求摘要与签名", () => {
    // AWS S3 SigV4 文档示例：examplebucket/test.txt，带 Range 头；
    // 文档公布的规范请求摘要为 7344ae5b...，用它反推签名即可验证整条签名链。
    const documentedCanonicalRequestSha256 = "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972";
    const payloadSha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const headers = signAwsV4Request({
      method: "GET",
      canonicalUri: "/test.txt",
      query: [],
      host: "examplebucket.s3.amazonaws.com",
      payloadSha256,
      amazonDateTime: "20130524T000000Z",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: exampleCredentials.secretAccessKey },
      additionalHeaders: { range: "bytes=0-9" }
    });
    const expectedSignature = referenceSignature(documentedCanonicalRequestSha256, {
      amazonDateTime: "20130524T000000Z",
      region: "us-east-1",
      service: "s3",
      secretAccessKey: exampleCredentials.secretAccessKey
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
      + "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
      + `Signature=${expectedSignature}`
    );
    expect(headers["x-amz-content-sha256"]).toBe(payloadSha256);
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
  });

  it("对 ListObjectsV2 复现 AWS 文档的带查询规范请求摘要", () => {
    // AWS S3 SigV4 文档示例：GET Bucket（max-keys=2&prefix=J），文档摘要为 df57d21d...
    const documentedCanonicalRequestSha256 = "df57d21db20da04d7fa30298dd4488ba3a2b47ca3a489c74750e0f1e7df1b9b7";
    const headers = signAwsV4Request({
      method: "GET",
      canonicalUri: "/",
      query: [["max-keys", "2"], ["prefix", "J"]],
      host: "examplebucket.s3.amazonaws.com",
      payloadSha256: createHash("sha256").update("").digest("hex"),
      amazonDateTime: "20130524T000000Z",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: exampleCredentials.secretAccessKey }
    });
    expect(headers.authorization).toContain(`Signature=${referenceSignature(documentedCanonicalRequestSha256, {
      amazonDateTime: "20130524T000000Z",
      region: "us-east-1",
      service: "s3",
      secretAccessKey: exampleCredentials.secretAccessKey
    })}`);
  });

  it("查询参数按键名排序后参与签名，顺序不同得到相同签名", () => {
    const base = {
      method: "GET" as const,
      canonicalUri: "/bucket",
      host: "s3.example.com",
      payloadSha256: createHash("sha256").update("").digest("hex"),
      amazonDateTime: "20260804T010203Z",
      region: "cn-north-1",
      credentials: exampleCredentials
    };
    const ascending = signAwsV4Request({ ...base, query: [["list-type", "2"], ["prefix", "a/b"]] });
    const descending = signAwsV4Request({ ...base, query: [["prefix", "a/b"], ["list-type", "2"]] });
    expect(ascending.authorization).toBe(descending.authorization);
  });

  it("请求头名称统一小写并按名称排序", () => {
    const headers = signAwsV4Request({
      method: "PUT",
      canonicalUri: "/bucket/key",
      query: [],
      host: "s3.example.com",
      payloadSha256: createHash("sha256").update("body").digest("hex"),
      amazonDateTime: "20260804T010203Z",
      region: "us-east-1",
      credentials: exampleCredentials,
      additionalHeaders: { "Content-Type": "application/octet-stream", "Content-Length": "4" }
    });
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(headers.authorization).toContain("SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date");
  });

  it("按 ISO 8601 基本格式输出签名时间", () => {
    expect(formatAmazonDateTime(new Date("2026-08-04T11:22:33.444Z"))).toBe("20260804T112233Z");
  });
});

describe("对象键编码", () => {
  it("保留未保留字符并按需编码斜杠", () => {
    expect(uriEncodeComponent("abc-_.~123")).toBe("abc-_.~123");
    expect(uriEncodeComponent("a/b c+d")).toBe("a%2Fb%20c%2Bd");
    expect(uriEncodeComponent("a/b c+d", false)).toBe("a/b%20c%2Bd");
    expect(uriEncodeComponent("第一卷")).toBe("%E7%AC%AC%E4%B8%80%E5%8D%B7");
  });
});

describe("备份子目录规范化", () => {
  it("去掉首尾斜杠与空片段", () => {
    expect(normalizeBackupPrefix("  /team//alpha/ ")).toBe("team/alpha");
    expect(normalizeBackupPrefix("")).toBe("");
    expect(normalizeBackupPrefix("   ")).toBe("");
    expect(normalizeBackupPrefix("单层中文目录")).toBe("单层中文目录");
  });

  it("拒绝路径穿越、反斜杠、控制字符与超长片段", () => {
    for (const value of ["../escape", "team/../../etc", "./here", "team\\alpha", "bad\u0000dir", "tab\tdir"]) {
      expect(() => normalizeBackupPrefix(value)).toThrowError(AppError);
    }
    expect(() => normalizeBackupPrefix(`${"a".repeat(129)}`)).toThrowError(/单层名称/u);
    expect(() => normalizeBackupPrefix(Array.from({ length: 10 }, () => "a".repeat(100)).join("/"))).toThrowError(/512/u);
  });
});

describe("备份对象键拼接", () => {
  it("未配置子目录时落在桶根目录的 scriverse 下", () => {
    expect(buildBackupObjectKey("")).toBe("scriverse");
    expect(buildBackupObjectKey("", "db", "novel-1.db")).toBe("scriverse/db/novel-1.db");
    expect(backupDatabasePrefix("")).toBe("scriverse/db/");
    expect(backupImagePrefix("")).toBe("scriverse/img/");
  });

  it("配置子目录时嵌套在该子目录下", () => {
    expect(buildBackupObjectKey("team/alpha", "img", "ab/hash.webp")).toBe("team/alpha/scriverse/img/ab/hash.webp");
    expect(backupDatabasePrefix("/team/alpha/")).toBe("team/alpha/scriverse/db/");
    expect(backupImagePrefix("team/alpha")).toBe("team/alpha/scriverse/img/");
  });
});

describe("S3 响应解析", () => {
  it("解析错误码、描述和请求 ID", () => {
    expect(parseS3ErrorPayload(
      '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access &amp; Denied</Message><RequestId>REQ-1</RequestId></Error>'
    )).toEqual({ code: "AccessDenied", message: "Access & Denied", requestId: "REQ-1" });
  });

  it("非 XML 或空响应体返回空字段", () => {
    expect(parseS3ErrorPayload("")).toEqual({ code: "", message: "", requestId: "" });
    expect(parseS3ErrorPayload("gateway timeout")).toEqual({ code: "", message: "", requestId: "" });
  });

  it("解析对象列表并还原 XML 实体", () => {
    const parsed = parseListObjectsPayload(
      "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>TOKEN-2</NextContinuationToken>"
      + "<Contents><Key>scriverse/db/a&amp;b.db</Key><Size>128</Size><LastModified>2026-08-04T00:00:00.000Z</LastModified></Contents>"
      + "<Contents><Key>scriverse/db/c.db</Key><Size>64</Size><LastModified>2026-08-03T00:00:00.000Z</LastModified></Contents>"
      + "</ListBucketResult>"
    );
    expect(parsed.truncated).toBe(true);
    expect(parsed.nextContinuationToken).toBe("TOKEN-2");
    expect(parsed.objects).toEqual([
      { key: "scriverse/db/a&b.db", size: 128, lastModified: "2026-08-04T00:00:00.000Z" },
      { key: "scriverse/db/c.db", size: 64, lastModified: "2026-08-03T00:00:00.000Z" }
    ]);
  });

  it("空列表和缺失字段不会产生异常条目", () => {
    expect(parseListObjectsPayload("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>")).toEqual({
      objects: [],
      nextContinuationToken: "",
      truncated: false
    });
    expect(parseListObjectsPayload("<ListBucketResult><Contents><Size>1</Size></Contents></ListBucketResult>").objects).toEqual([]);
  });
});
