import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  awsUriEncode,
  backupRootKey,
  buildCanonicalRequest,
  buildStringToSign,
  canonicalHeaderBlock,
  canonicalQueryString,
  computeNextScheduledRun,
  computeSignature,
  dbSnapshotFileName,
  normalizeS3Prefix,
  sha256Hex
} from "../../src/s3-backup.js";

describe("S3 备份 SigV4 签名", () => {
  it("按 AWS 规范编码 URI", () => {
    expect(awsUriEncode("a/b c+d~e")).toBe("a%2Fb%20c%2Bd~e");
    expect(awsUriEncode("a/b", false)).toBe("a/b");
    expect(awsUriEncode("汉")).toBe("%E6%B1%89");
  });

  it("按键名排序并编码查询串", () => {
    expect(canonicalQueryString({ "list-type": "2", prefix: "scriverse/db/", "max-keys": "1000" }))
      .toBe("list-type=2&max-keys=1000&prefix=scriverse%2Fdb%2F");
  });

  it("规范化头部并按签名顺序列出", () => {
    expect(canonicalHeaderBlock({ "x-amz-date": "20260815T000000Z", host: "s3.example.com" })).toEqual({
      canonical: "host:s3.example.com\nx-amz-date:20260815T000000Z\n",
      signedNames: "host;x-amz-date"
    });
  });

  it("构造与 AWS SigV4 测试套件一致的规范请求", () => {
    const canonical = buildCanonicalRequest(
      "GET",
      "/",
      "",
      { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
      sha256Hex("")
    );
    expect(canonical).toBe([
      "GET",
      "/",
      "",
      "host:example.amazonaws.com\nx-amz-date:20150830T123600Z\n",
      "host;x-amz-date",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    ].join("\n"));
  });

  it("构造待签名串并派生签名密钥", () => {
    const canonicalRequest = buildCanonicalRequest(
      "GET",
      "/",
      "",
      { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
      sha256Hex("")
    );
    const stringToSign = buildStringToSign("20150830T123600Z", "20150830/us-east-1/s3/aws4_request", canonicalRequest);
    expect(stringToSign).toBe([
      "AWS4-HMAC-SHA256",
      "20150830T123600Z",
      "20150830/us-east-1/s3/aws4_request",
      sha256Hex(canonicalRequest)
    ].join("\n"));
    // 按文档 HMAC 链独立复算签名，验证 computeSignature 与标准派生一致。
    const secretKey = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
    const kDate = createHmac("sha256", "AWS4" + secretKey).update("20150830").digest();
    const kRegion = createHmac("sha256", kDate).update("us-east-1").digest();
    const kService = createHmac("sha256", kRegion).update("s3").digest();
    const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
    const expected = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
    expect(computeSignature("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830", "us-east-1", stringToSign)).toBe(expected);
  });
});

describe("S3 备份目录与文件名", () => {
  it("规范化子目录并拼接 /scriverse 根目录", () => {
    expect(normalizeS3Prefix(" /backups/novel/ ")).toBe("backups/novel");
    expect(normalizeS3Prefix("a//b/")).toBe("a/b");
    expect(backupRootKey("backups/novel")).toBe("backups/novel/scriverse");
    expect(backupRootKey("")).toBe("scriverse");
    expect(() => normalizeS3Prefix("a$b")).toThrow();
    expect(() => normalizeS3Prefix("x".repeat(501))).toThrow();
  });

  it("数据库快照文件名包含定长时间戳且不覆盖历史", () => {
    const first = dbSnapshotFileName(new Date("2026-08-15T03:00:00.123Z"));
    const second = dbSnapshotFileName(new Date("2026-08-15T03:00:00.456Z"));
    expect(first).toBe("scriverse-db-20260815T030000123Z.db");
    expect(second).toBe("scriverse-db-20260815T030000456Z.db");
    expect([first, second].sort()).toEqual([first, second]);
  });
});

describe("S3 定时备份触发时间", () => {
  it("当天未到则今天触发，已过则顺延到明天", () => {
    const base = new Date(2026, 7, 15, 10, 0, 0);
    expect(computeNextScheduledRun(base, "11:30")).toEqual(new Date(2026, 7, 15, 11, 30, 0));
    expect(computeNextScheduledRun(base, "03:00")).toEqual(new Date(2026, 7, 16, 3, 0, 0));
    expect(computeNextScheduledRun(base, "10:00")).toEqual(new Date(2026, 7, 16, 10, 0, 0));
    expect(computeNextScheduledRun(base, "00:00")).toEqual(new Date(2026, 7, 16, 0, 0, 0));
    expect(computeNextScheduledRun(base, "23:59")).toEqual(new Date(2026, 7, 15, 23, 59, 0));
  });

  it("拒绝非法时间格式", () => {
    expect(() => computeNextScheduledRun(new Date(), "24:00")).toThrow();
    expect(() => computeNextScheduledRun(new Date(), "3:5")).toThrow();
    expect(() => computeNextScheduledRun(new Date(), "12:60")).toThrow();
  });
});
