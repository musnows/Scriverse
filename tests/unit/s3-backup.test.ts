import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  backupBasePath,
  buildS3Url,
  createAwsV4Authorization,
  encodeS3Key,
  maskAccessKey,
  nextScheduleDelayMs,
  normalizeBackupPrefix,
  normalizeScheduleTime,
  parseListObjectsKeys,
  parseS3ErrorBody,
  selectExpiredBackupKeys,
  timestampForBackupFile
} from "../../src/s3-backup.js";
import { AppError } from "../../src/errors.js";

describe("备份定时时间", () => {
  it("接受并规范化 HH:mm", () => {
    expect(normalizeScheduleTime("03:00")).toBe("03:00");
    expect(normalizeScheduleTime(" 9:5 ")).toBe("09:05");
    expect(normalizeScheduleTime("23:59")).toBe("23:59");
  });

  it("拒绝非法格式", () => {
    for (const value of ["", "24:00", "12:60", "1200", "ab:cd", "12:00:00"]) {
      expect(() => normalizeScheduleTime(value)).toThrow(AppError);
    }
  });

  it("计算下一次触发的延迟", () => {
    const now = new Date(2026, 7, 3, 10, 0, 0);
    expect(nextScheduleDelayMs("10:30", now)).toBe(30 * 60 * 1000);
    // 当天时间已过时顺延到第二天
    expect(nextScheduleDelayMs("09:00", now)).toBe(23 * 60 * 60 * 1000);
    // 恰好等于当前时间视为已过
    expect(nextScheduleDelayMs("10:00", now)).toBe(24 * 60 * 60 * 1000);
  });
});

describe("备份子目录前缀", () => {
  it("去除首尾斜杠并折叠重复斜杠", () => {
    expect(normalizeBackupPrefix("/my-dir/sub//")).toBe("my-dir/sub");
    expect(normalizeBackupPrefix("")).toBe("");
    expect(normalizeBackupPrefix("   ")).toBe("");
  });

  it("拒绝路径穿越", () => {
    expect(() => normalizeBackupPrefix("../etc")).toThrow(AppError);
    expect(() => normalizeBackupPrefix("a/./b")).toThrow(AppError);
    expect(normalizeBackupPrefix("a//b//c")).toBe("a/b/c");
  });

  it("拼接 /scriverse 基础路径", () => {
    expect(backupBasePath("")).toBe("scriverse");
    expect(backupBasePath("team/novel")).toBe("team/novel/scriverse");
  });
});

describe("S3 对象键与 URL 构造", () => {
  it("逐段编码对象键并保留分隔符", () => {
    expect(encodeS3Key("scriverse/img/ab/c d.webp")).toBe("scriverse/img/ab/c%20d.webp");
  });

  it("默认使用虚拟主机风格", () => {
    const url = buildS3Url({ endpoint: "https://s3.example.com", bucket: "novel", key: "scriverse/db/a.db", pathStyle: false });
    expect(url.href).toBe("https://novel.s3.example.com/scriverse/db/a.db");
  });

  it("支持路径风格与查询参数", () => {
    const url = buildS3Url({ endpoint: "http://127.0.0.1:9000", bucket: "novel", pathStyle: true, query: { "list-type": "2", prefix: "scriverse/db/" } });
    expect(url.origin).toBe("http://127.0.0.1:9000");
    expect(url.pathname).toBe("/novel");
    expect(url.searchParams.get("list-type")).toBe("2");
    expect(url.searchParams.get("prefix")).toBe("scriverse/db/");
  });

  it("拒绝非法服务地址", () => {
    expect(() => buildS3Url({ endpoint: "not-a-url", bucket: "novel", pathStyle: false })).toThrow(AppError);
    expect(() => buildS3Url({ endpoint: "ftp://s3.example.com", bucket: "novel", pathStyle: false })).toThrow(AppError);
  });
});

describe("访问密钥脱敏", () => {
  it("仅保留末四位", () => {
    expect(maskAccessKey("AKIAIOSFODNN7EXAMPLE")).toBe("****MPLE");
    expect(maskAccessKey("abc")).toBe("****");
  });
});

describe("数据库备份留存选择", () => {
  const keys = [
    "scriverse/db/scriverse-20260803-030000-aaa.db",
    "scriverse/db/scriverse-20260801-030000-bbb.db",
    "scriverse/db/scriverse-20260802-030000-ccc.db"
  ];

  it("未超出留存数量时不删除", () => {
    expect(selectExpiredBackupKeys(keys, 3)).toEqual([]);
    expect(selectExpiredBackupKeys(keys, 10)).toEqual([]);
  });

  it("超出时删除最老的备份", () => {
    expect(selectExpiredBackupKeys(keys, 2)).toEqual(["scriverse/db/scriverse-20260801-030000-bbb.db"]);
    expect(selectExpiredBackupKeys(keys, 1)).toEqual([
      "scriverse/db/scriverse-20260801-030000-bbb.db",
      "scriverse/db/scriverse-20260802-030000-ccc.db"
    ]);
  });
});

describe("S3 XML 响应解析", () => {
  it("解析错误响应中的 Code 与 Message", () => {
    const parsed = parseS3ErrorBody("<?xml version=\"1.0\"?><Error><Code>AccessDenied</Code><Message>Access &amp; Denied</Message></Error>");
    expect(parsed.code).toBe("AccessDenied");
    expect(parsed.message).toBe("Access & Denied");
  });

  it("解析对象列表并支持分页标记", () => {
    const xml = `<ListBucketResult><IsTruncated>true</IsTruncated>
      <NextContinuationToken>token-1</NextContinuationToken>
      <Contents><Key>scriverse/db/a.db</Key></Contents>
      <Contents><Key>scriverse/img/ab/c.webp</Key></Contents></ListBucketResult>`;
    const parsed = parseListObjectsKeys(xml);
    expect(parsed.keys).toEqual(["scriverse/db/a.db", "scriverse/img/ab/c.webp"]);
    expect(parsed.truncated).toBe(true);
    expect(parsed.nextToken).toBe("token-1");
  });

  it("空列表返回空结果", () => {
    const parsed = parseListObjectsKeys("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>");
    expect(parsed.keys).toEqual([]);
    expect(parsed.truncated).toBe(false);
    expect(parsed.nextToken).toBeNull();
  });
});

describe("备份文件名时间戳", () => {
  it("生成紧凑的本地时间戳", () => {
    expect(timestampForBackupFile(new Date(2026, 7, 3, 3, 5, 9))).toBe("20260803-030509");
  });
});

describe("AWS Signature V4", () => {
  const options = {
    method: "PUT",
    url: new URL("https://novel.s3.example.com/scriverse/db/a.db"),
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    payloadHash: createHash("sha256").update("payload").digest("hex"),
    date: new Date(Date.UTC(2026, 7, 3, 0, 0, 0))
  };

  // 测试内独立实现的参照签名流程，用于交叉验证主实现的组装顺序。
  function referenceSignature(): string {
    const amzDate = "20260803T000000Z";
    const dateStamp = "20260803";
    const canonicalRequest = [
      "PUT",
      "/scriverse/db/a.db",
      "",
      `host:novel.s3.example.com\nx-amz-content-sha256:${options.payloadHash}\nx-amz-date:${amzDate}\n`,
      "host;x-amz-content-sha256;x-amz-date",
      options.payloadHash
    ].join("\n");
    const scope = `${dateStamp}/us-east-1/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
    const hmac = (key: Buffer | string, value: string): Buffer => createHmac("sha256", key).update(value).digest();
    return hmac(hmac(hmac(hmac(hmac(`AWS4${options.secretAccessKey}`, dateStamp), "us-east-1"), "s3"), "aws4_request"), stringToSign).toString("hex");
  }

  it("Authorization 头符合 SigV4 结构", () => {
    const headers = createAwsV4Authorization(options);
    expect(headers["x-amz-date"]).toBe("20260803T000000Z");
    expect(headers["x-amz-content-sha256"]).toBe(options.payloadHash);
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260803\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/u
    );
  });

  it("签名结果与参照实现一致", () => {
    const headers = createAwsV4Authorization(options);
    const signature = /Signature=([0-9a-f]{64})$/u.exec(headers["authorization"] ?? "")?.[1] ?? "";
    expect(signature).toBe(referenceSignature());
  });

  it("不同密钥产生不同签名且结果确定", () => {
    const first = createAwsV4Authorization(options).authorization;
    const again = createAwsV4Authorization(options).authorization;
    const other = createAwsV4Authorization({ ...options, secretAccessKey: "another-secret-key" }).authorization;
    expect(first).toBe(again);
    expect(first).not.toBe(other);
  });

  it("对查询参数排序后参与签名", () => {
    const withQuery = createAwsV4Authorization({ ...options, url: new URL("https://novel.s3.example.com/?prefix=b&a=1") });
    expect(withQuery.authorization).toMatch(/Signature=[0-9a-f]{64}$/u);
  });
});
